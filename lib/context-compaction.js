/** Proactive, durable context compaction for the Codex subscription route. */
export function registerContextCompaction(ctx, { createFallbackEngine } = {}) {
  const pending = new WeakMap();
  const overflowRetries = new WeakMap();
  const overflowOwners = new WeakMap();
  let warnedUnavailable = false;
  const service = (agent, name) => agent.ctx?.get?.(name) ?? ctx.get?.(name);

  async function compact(agent, signal, force = false) {
    signal.throwIfAborted();
    const route = agent.session.requestHeader()?.config ?? agent.options;
    if (route?.provider !== 'codex-subscription' || !route.model) return false;
    const llm = service(agent, 'llm');
    const meter = service(agent, 'tokenMeter');
    if (!llm?.resolveModelInfo || !meter?.measure) {
      if (!warnedUnavailable) {
        warnedUnavailable = true;
        ctx.logger?.warn?.('dsh-codex-connect: 当前作用域尚未提供上下文计量，自动压缩本步跳过，Codex 模型保持可用。');
      }
      return false;
    }
    const info = await llm.resolveModelInfo(route.provider, route.model, signal);
    signal.throwIfAborted();
    const capacity = info?.context?.contextWindow;
    const reserved = route.maxTokens ?? info?.defaultMaxTokens ?? 0;
    if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(reserved) || reserved < 0) {
      throw new Error('Codex 自动压缩无法确定模型上下文容量。');
    }
    const threshold = capacity * 0.9;
    const measure = () => {
      const tokens = meter.measure(agent.session).totalTokens;
      if (!Number.isFinite(tokens) || tokens < 0) throw new Error('Codex 自动压缩无法计量当前上下文。');
      return tokens + reserved;
    };
    let pressure = measure();
    // A root realm need not provide compaction at all. Resolve/create it only
    // when pressure actually reaches the threshold, independently of models.
    let engine;
    if (force || pressure >= threshold) {
      // A dedicated engine guarantees bounded summary calls even above 100%;
      // unrelated ACP/bili services may deliberately disable native pressure.
      engine = createFallbackEngine
        ? await createFallbackEngine(agent, { llm, meter, sessions: service(agent, 'sessions') })
        : service(agent, 'compaction');
    }
    let compressed = false;
    for (let attempt = 0; attempt < 8 && (pressure >= threshold || force && attempt === 0); attempt++) {
      signal.throwIfAborted();
      // ACP keeps originals in the durable log and preserves its recent-message
      // tail; basic compaction uses its normal summarization transaction.
      if (typeof engine?.compactForOverflow === 'function') {
        await engine.compactForOverflow(agent, signal);
      } else if (typeof engine?.compactIfNeeded === 'function') {
        await engine.compactIfNeeded(agent, force ? 'context-overflow' : 'pressure', signal);
      } else {
        throw new Error('Codex 自动压缩失败：当前压缩后端不支持自动压缩。');
      }
      signal.throwIfAborted();
      const after = measure();
      ctx.logger?.info?.(`dsh-codex-connect: 自动压缩上下文 ${Math.round(pressure / capacity * 100)}% → ${Math.round(after / capacity * 100)}%（阈值 90%）`);
      if (after >= pressure) throw new Error('Codex 上下文达到 90%，但没有可安全压缩的旧内容；请减少本轮附件或系统提示。原会话已保留。');
      compressed = true;
      pressure = after;
    }
    if (pressure >= threshold) throw new Error('Codex 自动压缩后上下文仍达到 90%，已停止发送超大请求；请减少本轮输入。');
    return compressed;
  }

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') { overflowRetries.delete(agent); overflowOwners.delete(agent.session); }
  });
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return;
    const owner = overflowOwners.get(session);
    if (owner) overflowRetries.delete(owner);
    overflowOwners.delete(session);
  });
  ctx.on('agent/request-error', async ({ agent, failure, signal }, next) => {
    if (failure.code !== 'CONTEXT_WINDOW_EXCEEDED' || signal.aborted) return next();
    const attempts = overflowRetries.get(agent) ?? 0;
    if (attempts >= 2) return next();
    overflowRetries.set(agent, attempts + 1);
    overflowOwners.set(agent.session, agent);
    try {
      if (await compact(agent, signal, true)) {
        ctx.logger?.info?.('dsh-codex-connect: 服务端确认超窗，已强制分段压缩，自动重试请求。');
        return { kind: 'retry' };
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-codex-connect: 超窗恢复失败，原会话已保留：${error.message}`);
    }
    return next();
  });

  return ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    let operation = pending.get(agent);
    if (!operation) {
      operation = compact(agent, signal);
      pending.set(agent, operation);
    }
    try { await operation; signal.throwIfAborted(); }
    finally { if (pending.get(agent) === operation) pending.delete(agent); }
    return next();
  });
}

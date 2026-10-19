import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerContextCompaction } from '../lib/context-compaction.js';

function setup(tokens, overrides = {}, options = {}) {
  const handlers = new Map();
  let compressed = 0, continued = 0;
  const session = { requestHeader: () => ({ config: { provider: 'codex-subscription', model: 'test' } }) };
  const services = {
    llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1000 } }) },
    tokenMeter: { measure: () => ({ totalTokens: tokens }) },
    compaction: { compactForOverflow: async () => { compressed++; tokens = 400; return {} } },
    ...overrides,
  };
  const ctx = { on: (name, fn) => handlers.set(name, fn), get: name => services[name], logger: { info() {}, warn() {} } };
  const agent = { session, ctx, options: {} };
  registerContextCompaction(ctx, options);
  return { agent, runError: async (code='CONTEXT_WINDOW_EXCEEDED') => {
    const handler=handlers.get('agent/request-error'); assert.equal(typeof handler,'function','provider overflow needs forced compaction recovery');
    return handler({agent,failure:{code},signal:new AbortController().signal},async()=>({kind:'stop'}));
  }, run: (signal = new AbortController().signal) => handlers.get('agent/pre-step')({ agent, signal }, async () => { continued++; return { kind: 'enter' } }), get compressed() { return compressed }, get continued() { return continued } };
}

test('89.9% passes without compaction', async () => { const s = setup(899); await s.run(); assert.equal(s.compressed, 0); assert.equal(s.continued, 1) });
test('90% and above compact automatically before continuing', async () => { for (const tokens of [900, 1001]) { const s = setup(tokens); await s.run(); assert.equal(s.compressed, 1); assert.equal(s.continued, 1) } });
test('completion reservation counts toward the 90% limit', async () => { const s = setup(800, { llm: { resolveModelInfo: async () => ({ context: { contextWindow: 1000 }, defaultMaxTokens: 100 }) } }); await s.run(); assert.equal(s.compressed, 1) });
test('other providers are unaffected', async () => { const s = setup(999); s.agent.session.requestHeader = () => ({ config: { provider: 'other', model: 'test' } }); await s.run(); assert.equal(s.compressed, 0) });
test('cancelled step never compacts or sends request', async () => { const s = setup(999); const c = new AbortController(); c.abort(); await assert.rejects(s.run(c.signal)); assert.equal(s.compressed, 0); assert.equal(s.continued, 0) });
test('no progress stops safely instead of sending oversized input', async () => { const s = setup(999, { compaction: { compactForOverflow: async () => null } }); await assert.rejects(s.run(), /压缩/); assert.equal(s.continued, 0) });
test('basic backend pressure compaction is supported', async () => { let tokens = 900; const s = setup(0, { tokenMeter: { measure: () => ({ totalTokens: tokens }) }, compaction: { compactIfNeeded: async (_agent, trigger) => { assert.equal(trigger, 'pressure'); tokens = 400; return {} } } }); await s.run(); assert.equal(s.continued, 1) });
test('remeasures and compresses again when one range is insufficient', async () => {
  let tokens = 1100, calls = 0;
  const s = setup(0, { tokenMeter: { measure: () => ({ totalTokens: tokens }) }, compaction: { compactForOverflow: async () => { calls++; tokens -= 100 } } });
  await s.run(); assert.equal(calls, 3); assert.equal(s.continued, 1);
});
test('backend failure preserves failure and prevents next model request', async () => {
  const s = setup(900, { compaction: { compactForOverflow: async () => { throw new Error('durable write failed') } } });
  await assert.rejects(s.run(), /durable write failed/); assert.equal(s.continued, 0);
});
test('retry bound prevents endless compaction', async () => {
  let tokens = 1000, calls = 0;
  const s = setup(0, { tokenMeter: { measure: () => ({ totalTokens: tokens }) }, compaction: { compactForOverflow: async () => { calls++; tokens-- } } });
  await assert.rejects(s.run(), /仍达到 90%/); assert.equal(calls, 8); assert.equal(s.continued, 0);
});
test('normal requests work when root realm has no compaction service', async () => {
  const s = setup(100, { compaction: undefined }); await s.run(); assert.equal(s.continued, 1);
});
test('90% uses a private backend when no realm compaction service exists', async () => {
  let tokens = 900, created = 0;
  const s = setup(0, { tokenMeter: { measure: () => ({ totalTokens: tokens }) }, compaction: undefined }, {
    createFallbackEngine: async () => { created++; return { compactIfNeeded: async () => { tokens = 400 } } },
  });
  await s.run(); assert.equal(created, 1); assert.equal(s.continued, 1);
});
test('optional metering unavailability does not disable ordinary Codex requests', async () => {
  const s = setup(100, { tokenMeter: undefined, compaction: undefined }); await s.run(); assert.equal(s.continued, 1);
});
test('provider-confirmed overflow forces compression even below estimated 90%', async () => {
  let tokens=500, forced=0;
  const s=setup(0,{tokenMeter:{measure:()=>({totalTokens:tokens})},compaction:undefined},{createFallbackEngine:async()=>({compactIfNeeded:async(_a,trigger)=>{assert.equal(trigger,'context-overflow');forced++;tokens-=100}})});
  assert.deepEqual(await s.runError(),{kind:'retry'});assert.equal(forced,1);
});
test('non-context failures do not trigger compaction retries', async () => {
  const s=setup(500);assert.deepEqual(await s.runError('RATE_LIMIT'),{kind:'stop'});assert.equal(s.compressed,0);
});

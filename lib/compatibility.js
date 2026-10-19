export function requireCodexCapabilities(api, ctx) {
  const missing = ['PiAiAdapter', 'resolveImageAttachmentAccess', 'resolveRetryPolicy'].filter(name => typeof api[name] !== 'function');
  if (typeof ctx?.llm?.registerAdapter !== 'function') missing.push('ctx.llm.registerAdapter');
  if (typeof ctx?.webServer?.register !== 'function') missing.push('ctx.webServer.register');
  if (missing.length) throw new Error('dsh-codex-connect: 当前 DSH 缺少必要接口：' + missing.join(', ') + '。请使用保留这些接口的 DSH 版本，或更新插件。');
}

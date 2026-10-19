# dsh-codex-connect

把本地 **Codex CLI 已登录的 ChatGPT 订阅模型**接入 DeepSeek Harness 的模型选择器——复用 `~/.codex/auth.json` 登录态，**零 OAuth 流程、零新费用**（走你现有的 ChatGPT Plus/Pro 订阅额度）。

参照 [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 的接入方式实现。

## 前提

1. 本机已安装并登录 Codex CLI（ChatGPT 登录态）：
   ```powershell
   npm install -g @openai/codex
   codex.cmd login   # 选 Sign in with ChatGPT
   ```
2. 验证登录态：`codex.cmd login status` 应显示 `Logged in using ChatGPT`。

## 0.2.1（适配 DSH 0.2.1-rc.1 / rc.2）

**根因**：`chatgpt.com` 走不通不是版本号问题，是网络层问题。pi-ai 用 `globalThis.fetch` 发请求且**不读 Windows 系统代理**，Node 的 fetch 同样不读；于是在有系统代理的机器上，模型列表正常但真实对话全部以 `fetch failed` / `PROVIDER_TRANSPORT_FAILURE` 结束。0.1.x 只给用量查询修了代理，聊天链路没修——这才是"插件不兼容"的实际表现。

- 聊天链路与用量查询**共用同一个代理决策**：`HTTPS_PROXY` 等环境变量优先，其次读 Windows `Internet Settings` 的已启用系统代理；两者都没有则直连。未配置代理的机器行为不变。
- 代理通过 `options.fetch` 注入 pi-ai（这是 pi-ai 支持的官方入口），并强制 `transport: "sse"`——WebSocket 通道不接受自定义 fetch，走代理会失败。
- `undici` 的 `fetch` 与 `ProxyAgent` 必须来自同一实例，混用不同版本会得到 `UND_ERR_INVALID_ARG`；本插件用一次懒加载同时取二者，直连时完全不加载 `undici`。
- 依赖对齐 DSH 0.2.1-rc.1 / rc.2：`@earendil-works/pi-ai` 从 0.87.1 升到 `^1.1.0`（与 `dsh-llm-pi-ai` 的依赖范围一致）。peer 声明使用下界范围（`@deepseek-ai/dsh-llm >=0.2.1-rc.1`、`dsh-llm-pi-ai >=0.2.1-rc.1`、`cordis >=4.0.5`、`schemastery >=3.18.5`），由 DSH 宿主提供，本包不自行安装。
  - 不能用 `"*"`：pnpm 会把 `@deepseek-ai/dsh-llm-pi-ai` 解析到 npm 上的 `latest`=`0.0.1-rc.1`，而那个远古版本 peer 里挂着从未发布的 `@deepseek-ai/dsh-environment`，安装直接 `ERR_PNPM_FETCH_404`。
  - 也不能用 `^0.2.1-rc.1`：`^` 对预发布版只匹配同一 minor 的预发布，会报 `ERR_PNPM_NO_MATCHING_VERSION`。
- 0.1.1 的用量代理修复保留：20 秒超时、加载失败可点击重试、不隐藏整个控件。

## 安装（desktop profile）

推荐在 DSH 插件管理器中从本仓库安装或更新：

```text
https://github.com/hxd2xff-png/dsh-codex-connect
```

安装器需启用 peer 自动安装；手动安装时可在 profile 目录运行：

```powershell
pnpm add github:hxd2xff-png/dsh-codex-connect --config.auto-install-peers=true
```

然后通过 DSH 的 bundle 管理启用 `dsh-codex-connect`，不要重复插入同名插件。DSH 相关包保留为 peer，避免为宿主服务创建不一致的独立副本；`dsh-llm-pi-ai` 的 brand、util-values 等普通传递依赖由包管理器自动安装。宿主需为 DSH `0.2.1-rc.1`。

本地源码安装方式：

```powershell
# 在 desktop profile 的 package.json 中设置：
# dependencies["dsh-codex-connect"] = "file:C:/完整路径/dsh-codex-connect"
# dsh.profile.bundles 中加入 "dsh-codex-connect"（只加一次）
# 源码目录必须在 node_modules 之外。

Set-Location "$env:USERPROFILE\.dsh\profiles\desktop"
$runtime = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime"
$node = (Get-Command node -ErrorAction Stop).Source
& $node "$runtime\pnpm\bin\pnpm.mjs" install --ignore-scripts

# 安装完成后退出并重新打开 DeepSeek Harness。
curl.exe -i --max-time 30 http://127.0.0.1:19387/plugins/dsh-codex-connect/usage
```

bundle 自带的 `cordis.patch.yml` 会插入宿主插件，不要在 profile 的 patch 中再次 insert。
200 表示插件已挂载且上游用量查询成功；502 表示路由已挂载但凭据或上游请求失败；404 表示当前宿主还没有该路由。仅通过 `node --check` 不代表模块能够导入或插件已经加载。

## 使用

重启 DSH 后，模型选择器里会出现 **"Codex · ChatGPT 订阅"** 分组，含：

| 模型 | 上下文 | 图片 |
|---|---|---|
| GPT-6.1 Sol | 272k | ✅ |
| GPT-6 Astra | 272k | ✅ |
| GPT-6 Sol | 272k | ✅ |
| GPT-6 Luna | 272k | ✅ |
| GPT-5.6 Sol | 272k | ✅ |
| GPT-5.6 Terra | 272k | ✅ |
| GPT-5.6 Luna | 272k | ✅ |

## 工作原理

```
DSH → PiAiAdapter → pi-ai openAICodexResponsesApi
    → https://chatgpt.com/backend-api/codex/responses
    （Authorization: Bearer <access_token from ~/.codex/auth.json>）
    （fetch: 插件注入的代理感知 fetch，仅在检测到代理时生效）
```

- **凭据只读**：插件只读 Codex CLI 的 auth.json，绝不写入。Codex CLI 是身份权威。
- **续期**：Codex CLI 使用时会自动刷新 auth.json；插件每次请求前检查有效期与文件 mtime，自动拾取 CLI 续期后的新 token。
- **token 过期时**：跑一次 `codex.cmd exec "hi"` 让 CLI 续期，插件自动恢复。

## 开发与验证

使用支持 Node 22/24 的 pnpm 安装（本次验证使用 pnpm 11.7.0）：

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
```

`check` 检查两端语法并真实导入宿主模块，能发现缺少依赖；它不代表 DSH 中插件已经激活。安装更新后建议完整退出并重新打开 DSH，再刷新页面并检查上面的同源用量接口。不要在当前会话依赖该 provider 时禁用插件，否则该会话会失去 adapter。

用量接口依赖可访问的 ChatGPT 网络与有效的 Codex CLI 登录态。系统代理在插件加载时读取一次；代理变更后需要重新加载插件（退出并重开 DSH）才生效。本版不管理 PAC 或 SOCKS 代理，也不自动续期登录凭据。Windows 按协议配置代理时读取 `https=` 条目。

## 已知限制

- 仅支持 Codex CLI 的文件凭据模式（`auth_mode=chatgpt`）；API key 模式不支持。
- token 临近过期时插件不主动代为刷新（避免与 CLI 的 refresh rotation 冲突）；需 CLI 侧跑一次触发续期。
- 模型目录为静态清单（与 pi-ai openai-codex 目录一致）；账号实际可用的模型以 ChatGPT 后端响应为准。
- 订阅限额与网页版 ChatGPT / Codex CLI 共享。


## 版本兼容性

本包不精确钉死 DSH 版本号：实际使用的核心 peer 一律写下界（`>=0.2.1-rc.1` 等），不直接使用的核心 peer 已从声明中移除。

加载时由 `lib/compatibility.js` 检查 `PiAiAdapter`、`resolveImageAttachmentAccess`、`resolveRetryPolicy`、`ctx.llm.registerAdapter`、`ctx.webServer.register` 是否存在；缺任何一个就抛出带明确清单的错误，而不是在后续流程里报难懂的 `undefined is not a function`。

已在 DSH `0.2.1-rc.1` 与 `0.2.1-rc.2` 上实际启动验证，rc.2 完成过真实订阅模型请求与用量查询。宿主保留这些接口时，无需仅因版本号变化而升级插件；接口语义一旦变化，仍需重新验证。

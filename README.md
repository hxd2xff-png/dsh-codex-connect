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

## 0.1.1 修复

- 用量查询优先读取 `HTTPS_PROXY` / `ALL_PROXY` / `HTTP_PROXY`（含小写）；没有环境代理时，在 Windows 读取当前用户已启用的系统代理。未配置代理则直连，不硬编码个人代理地址。
- 用量请求设置 20 秒超时；`fetch` 与 `ProxyAgent` 使用同一版本的 `undici`，避免与 Node 内置客户端混用。
- 首次加载失败不再隐藏整个用量控件，改为显示可点击重试的提示。登录态与模型调用逻辑保持不变。
- 补齐适配器依赖链中的 DSH peer 声明，新增 `undici` 运行依赖；`pnpm-lock.yaml` 锁定可复现的开发安装。不会打包 `node_modules` 或任何用户凭据。

## 安装（desktop profile）

推荐在 DSH 插件管理器中从本仓库安装或更新：

```text
https://github.com/hxd2xff-png/dsh-codex-connect
```

安装器需启用 peer 自动安装；手动安装时可在 profile 目录运行：

```powershell
pnpm add github:hxd2xff-png/dsh-codex-connect --config.auto-install-peers=true
```

然后通过 DSH 的 bundle 管理启用 `dsh-codex-connect`，不要重复插入同名插件。DSH 相关包保留为 peer，避免为宿主服务创建不一致的独立副本；`dsh-llm-pi-ai` 的 brand、util-values 等普通传递依赖由包管理器自动安装。宿主需与声明的 `0.2.0-rc.2` DSH 包版本兼容。

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

用量接口依赖可访问的 ChatGPT 网络与有效的 Codex CLI 登录态。若系统代理变更，需要重新加载插件/进程使新代理生效；本版不管理 PAC 或 SOCKS 代理，也不自动续期登录凭据。Windows 按协议配置代理时读取 `https=` 条目。

## 已知限制

- 仅支持 Codex CLI 的文件凭据模式（`auth_mode=chatgpt`）；API key 模式不支持。
- token 临近过期时插件不主动代为刷新（避免与 CLI 的 refresh rotation 冲突）；需 CLI 侧跑一次触发续期。
- 模型目录为静态清单（与 pi-ai openai-codex 目录一致）；账号实际可用的模型以 ChatGPT 后端响应为准。
- 订阅限额与网页版 ChatGPT / Codex CLI 共享。

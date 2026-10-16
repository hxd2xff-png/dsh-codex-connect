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

## 安装（desktop profile）

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
| GPT-5.3 Codex Spark | 128k | ❌ |
| GPT-5.5 | 272k | ✅ |
| GPT-5.6 Luna | 272k | ✅ |
| GPT-5.6 Sol | 272k | ✅ |
| GPT-5.6 Terra | 272k | ✅ |
| GPT-6 Astra | 272k | ✅ |

## 工作原理

```
DSH → PiAiAdapter → pi-ai openAICodexResponsesApi
    → https://chatgpt.com/backend-api/codex/responses
    （Authorization: Bearer <access_token from ~/.codex/auth.json>）
```

- **凭据只读**：插件只读 Codex CLI 的 auth.json，绝不写入。Codex CLI 是身份权威。
- **续期**：Codex CLI 使用时会自动刷新 auth.json；插件每次请求前检查有效期与文件 mtime，自动拾取 CLI 续期后的新 token。
- **token 过期时**：跑一次 `codex.cmd exec "hi"` 让 CLI 续期，插件自动恢复。

## 已知限制

- 仅支持 Codex CLI 的文件凭据模式（`auth_mode=chatgpt`）；API key 模式不支持。
- token 临近过期时插件不主动代为刷新（避免与 CLI 的 refresh rotation 冲突）；需 CLI 侧跑一次触发续期。
- 模型目录为静态清单（与 pi-ai openai-codex 目录一致）；账号实际可用的模型以 ChatGPT 后端响应为准。
- 订阅限额与网页版 ChatGPT / Codex CLI 共享。

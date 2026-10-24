# Feishu + Telegram + Codex Bridge

[English](README.md) | **简体中文**

![Feishu + Telegram + Codex Bridge](assets/banner.svg)

<p>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="Node.js 22.19+" src="https://img.shields.io/badge/node-%3E%3D22.19-blue">
  <img alt="Platform: Windows 10/11" src="https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey">
</p>

**从飞书或 Telegram 远程使用 Codex，同时保留对电脑上真实执行结果的可见证据。**

一个可配置的开源远程任务桥接：从飞书或 Telegram 发消息，让 Codex 在你自己的电脑上执行任务，再把结果、文件、链接和全屏截图送回聊天窗口。

它的重点不是“让模型说完成了”，而是把每条任务做成可验证的闭环：

```text
聊天入口 -> 统一执行内核 -> Codex 本地执行 -> 结果证据 -> 截图/文件/链接 -> 用户验收
```

> **安全警告：** 这是运行在“你自己的受信任电脑”上的全权限助手，不是公网服务、远程桌面或沙箱。只会执行你信任的模型和用户任务；不要部署到共享主机或开放给不受信任的人。

> 当前版本主要面向 Windows 10/11。飞书文档、桌面应用和本地截图依赖 `lark-cli`、PowerShell 和可交互桌面；核心任务调度和配置跟随逻辑是跨平台的。

## 为什么做这个项目

很多“远程 AI 助手”只完成了一半：

- 任务在后台跑了，但用户看不到窗口、文件或链接；
- 切换 API 后仍然使用旧模型，或者根本没有真的连上新接口；
- 模型回复“已完成”，但工具没有执行、文件不存在、截图也没有发出来；
- 日志、历史记录或聊天内容里意外留下 API Key、Bot Token；
- 高风险操作没有二次确认；
- 临时截图和预览文件越堆越多。

这个项目把这些问题放在同一条执行链里处理：先验证当前 API，再执行任务，独立检查工具证据和用户可见结果，失败时明确降级，不把“后台成功”冒充成“用户成功”。

## 核心能力

- **双入口，一个内核**：飞书和 Telegram 共用同一套任务队列、证据门禁、截图、文件回传、历史与清理逻辑。
- **CC Switch 动态跟随**：不硬编码 `--model`。每单读取当前 Codex `config.toml`、认证状态和 CC Switch 当前供应商。
- **支持官方 API、自有 API 和中转站**：只要 Codex 当前配置能正常调用，桥接就不限制供应商类型；在自有 API 与中转站之间切换时自动跟随当前配置。
- **切换后真实探测**：配置指纹变化时清理旧会话，等待稳定，再用 `codex exec --ephemeral` 做最小真实调用。端口响应或 HTTP 状态不能代替真实调用。
- **用户视角验收**：回复中说明结果在哪里看、怎么打开、怎么验证，以及哪些内容没有验证。
- **证据门禁**：解析工具调用和输出；没有证据时不说“已完成”。
- **全桌面截图**：支持多显示器、DPI 缩放，截图作为文件发送到聊天端；发送成功后才清理本地临时截图。
- **文件交付**：正式产物自动回传，临时预览文件不会混入正式交付。
- **高风险确认**：删除、支付、对外发送、安装、授权等操作必须由用户明确确认。
- **凭据脱敏**：日志、任务历史、审计、共享记忆、报告和最终回复统一脱敏。
- **健康监控**：桥接、飞书消费者、Telegram 轮询、Codex、API 实调、桌面截图分项检查。
- **可配置**：路径、聊天对象、白名单、代理、数据目录、端口和限制都在 `config.json` 或环境变量中配置。

## 工作效果

当用户从手机发出：

```text
你看一下电脑现在的状态，只读查看，弄完把结果和截图发我。
```

桥接会：

1. 检查并实际调用当前模型；
2. 让 Codex 读取桌面、窗口和系统状态；
3. 解析实际工具调用和结果；
4. 截取完整虚拟桌面；
5. 把文字和截图发回飞书或 Telegram；
6. 在文字里告诉用户“飞书哪里看、电脑哪里看、怎么验收”；
7. 清理任务级临时文件；
8. 将任务写入脱敏后的历史。

如果 API 切换失败，任务不会继续执行并把失败说成完成；用户会收到失败原因和下一步建议。

## 架构

```text
┌──────────────┐       ┌─────────────────────────────┐
│ Feishu/Lark  │──────▶│                             │
└──────────────┘       │   bridge.js (统一执行内核)    │
                       │                             │
┌──────────────┐       │  - 消息归一化 / 白名单        │
│  Telegram    │──────▶│  - 任务队列                   │
└──────────────┘       │  - 高风险确认                 │
                       │  - Codex 调用                 │
                       │  - 工具证据门禁               │
                       │  - 截图 / 文件 / 清理         │
                       │  - 健康检查 / 任务历史        │
                       └──────────────┬──────────────┘
                                      │
                       ┌──────────────▼──────────────┐
                       │ Codex CLI + 当前 API 配置    │
                       │ config.toml / auth / CC Switch│
                       └──────────────┬──────────────┘
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
          本地应用/浏览器        文件与目录          全屏桌面截图
```

详细设计见 [docs/ARCHITECTURE.zh-CN.md](docs/ARCHITECTURE.zh-CN.md)。

## 环境要求

### 必需

- Node.js **22.19+**
- Codex CLI，已在本机完成登录或配置 API
- Windows 10/11（完整桌面执行、截图和 Office 自动化）
- PowerShell `powershell.exe` 或 `pwsh`

### 飞书入口

- `lark-cli`：通过飞书应用身份接收和发送消息、上传文件
- 飞书应用 ID、单聊或目标会话 ID
- `lark-cli event` 事件消费者可用

### Telegram 入口

- BotFather 创建的 Telegram Bot
- Bot Token
- 允许执行任务的 Telegram 用户数字 ID
- 如本机网络需要代理，配置 `telegram.proxyUrl`

### CC Switch（可选）

- CC Switch 正在使用本地配置接管或热切换 Codex 供应商
- `ccSwitch.settingsPath` 指向 CC Switch 的 `settings.json`
- Codex 的 `config.toml` 和认证文件路径由 `codex.home` 指向

> 不安装 CC Switch 也可以运行。此时桥接会跟随 `codex.home/config.toml` 中的当前配置，只是不读取 CC Switch 的供应商选择 ID。

## 官方 API、自有 API 与中转站

桥接本身不绑定任何模型供应商。实际可用类型包括：

- OpenAI 官方 API 或 ChatGPT/Codex 登录；
- 自建或企业内部的 OpenAI 兼容网关；
- 第三方中转站提供的兼容 API；
- 通过 CC Switch、本地代理或其他 Codex provider 配置接入的服务。

### 使用中转站

在 CC Switch 或 Codex 配置中新增中转站供应商，填写中转站提供的 Base URL、模型名和密钥，并选择与中转站兼容的 API 类型。中转站至少需要支持 Codex 当前使用的接口协议；模型名称必须与中转站实际支持的名称一致。

建议先单独确认中转站可用，再运行：

```powershell
npm run model-check
```

实调成功表示当前 Base URL、模型和认证能真实返回结果，不代表中转站未来永久稳定。

### 在自有 API 与中转站之间切换

1. 在 CC Switch 中切换到目标供应商；
2. CC Switch 更新 Codex `config.toml`、认证信息或当前供应商 ID；
3. bridge 检测到配置指纹变化；
4. 旧模型会话被作废；
5. bridge 用新的配置做一次最小真实调用；
6. 成功后才继续执行任务，并把当前供应商、模型和耗时通知飞书和 Telegram。

因此不需要为每次切换修改代码，也不需要重启 bridge。若中转站配置错误，bridge 会阻止任务并报告失败，不会沿用旧 API 假装完成。

> 中转站会看到你发送给模型的提示和返回内容。请只使用你信任的服务，并把密钥放在 CC Switch、Codex 认证配置或本机环境变量中，不要写进任务正文或提交到仓库。

更完整的配置步骤见 [docs/API_PROVIDERS.zh-CN.md](docs/API_PROVIDERS.zh-CN.md)。
## 快速开始

```powershell
git clone https://github.com/your-name/feishu-telegram-codex-bridge.git
cd feishu-telegram-codex-bridge
npm install
Copy-Item config.example.json config.json
# 编辑 config.json，填入自己的飞书和 Telegram 配置
npm run selftest
npm run security:scan
npm run model-check
npm start
```

`config.json` 已在 `.gitignore` 中。不要把真实 token、Cookie、Authorization 或私密聊天内容提交到 Git。

如需开机自启，可运行：

```powershell
.\scripts\install-autostart.ps1
```

该脚本只创建当前用户的 Startup 快捷方式，不安装服务，也不需要管理员权限。

## 配置说明

### 飞书

```json
{
  "feishu": {
    "enabled": true,
    "larkCliPath": "C:\\path\\to\\lark-cli.exe",
    "appId": "cli_your_feishu_app_id",
    "chatId": "oc_your_feishu_chat_id"
  }
}
```

- 不启用飞书时设置 `"enabled": false`。
- `larkCliPath` 为空或失配时，桥接会在启动时明确报错，不会假装已连接。
- 飞书 API 凭据由 `lark-cli` 管理，本仓库不保存飞书 secret。

### Telegram

```json
{
  "telegram": {
    "enabled": true,
    "botToken": "YOUR_TELEGRAM_BOT_TOKEN",
    "allowedUserIds": [123456789],
    "proxyUrl": "http://127.0.0.1:7890"
  }
}
```

- `allowedUserIds` 为空时拒绝所有 Telegram 用户。
- Bot Token 只放在未提交的 `config.json` 或环境变量中。
- 长轮询失败会指数退避重试；健康卡会显示最后错误和轮询状态。

### Codex

```json
{
  "codex": {
    "executable": "",
    "home": "~/.codex",
    "cwd": "./data/workspace",
    "timeoutMs": 1200000,
    "probeTimeoutMs": 90000
  }
}
```

- `executable` 留空时自动查找 Codex CLI。
- `home` 是 Codex 配置、认证和会话目录。
- `cwd` 是远程任务的工作目录。
- `--model` 永远不写死；模型由当前 Codex 配置决定。

### CC Switch

```json
{
  "ccSwitch": {
    "enabled": true,
    "settingsPath": "~/.cc-switch/settings.json"
  }
}
```

桥接会生成不含密钥的配置指纹：

```text
Codex config hash + auth hash + CC Switch provider id + model + provider + base URL
```

指纹变化后：

1. 清除旧模型会话；
2. 等待配置稳定；
3. 真实调用当前模型；
4. 成功才允许继续任务；
5. 失败则降级健康状态并阻止任务；
6. 将结果通知到已启用渠道。

### 数据目录

默认所有运行数据都在项目内的 `data/`：

```text
data/
  workspace/
  downloads/
  outputs/
  temp/
  state.json
  health.json
  task-history.jsonl
  audit.jsonl
  shared-memory.md
  bridge.log
```

`data/` 默认不进入 Git。正式产物保留多久由 `storage.artifactRetentionHours` 控制；临时截图和任务文件在交付确认后立即清理。

## 命令

```powershell
npm start                 # 启动桥接
npm run selftest          # 22 项本地自检
npm run model-check       # 对当前 Codex/CC Switch API 做最小真实调用
npm run security:scan     # 扫描仓库中的疑似凭据
npm run sync-rules        # 将协议同步到配置的 AGENTS.md
```

## 环境变量覆盖

敏感值可以只通过环境变量提供，不必写入 `config.json`：

| 变量 | 作用 |
|---|---|
| `BRIDGE_CONFIG` | 指定配置文件路径 |
| `BRIDGE_DATA_DIR` | 覆盖运行数据目录 |
| `FEISHU_ENABLED` | `true` / `false` |
| `LARK_CLI_PATH` | `lark-cli` 可执行文件路径 |
| `FEISHU_APP_ID` | 飞书应用 ID |
| `FEISHU_CHAT_ID` | 飞书目标会话 ID |
| `FEISHU_NOTIFY_CHAT_ID` | 飞书通知会话 ID |
| `TELEGRAM_ENABLED` | `true` / `false` |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token |
| `TELEGRAM_ALLOWED_USER_IDS` | 逗号分隔的用户 ID 白名单 |
| `TELEGRAM_NOTIFY_CHAT_ID` | Telegram 通知目标 |
| `TELEGRAM_PROXY_URL` | Telegram 代理 |
| `CODEX_HOME` | Codex 配置/认证目录 |
| `CODEX_EXECUTABLE` | Codex CLI 路径 |
| `CODEX_CWD` | 远程任务工作目录 |
| `CC_SWITCH_SETTINGS` | CC Switch 设置文件路径 |
| `BRIDGE_AGENTS_FILES` | 可选，分号分隔的 `AGENTS.md` 同步目标 |
## 安全模型

- 默认只接受配置白名单中的 Telegram 用户。
- 高风险操作必须由用户本人明确回复确认。
- 不把 API Key、Bot Token、Authorization、Cookie 或密钥写入日志和历史。
- 历史、审计、共享记忆和最终回复都会统一脱敏。
- 截图、临时文件、正式产物分别管理；发送确认后才清理截图。
- 仓库中的 `config.json`、`.env`、`data/`、日志、截图、历史、二维码和缓存全部被忽略。
- 运行前执行 `npm run security:scan`；GitHub 公开仓库还会启用平台自带 secret scanning。

完整威胁模型和限制见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。

## 已知限制

- 电脑关机、休眠、锁屏或网络断开时，GUI 任务无法完成；桥接会报告无法核验，不会假装成功。
- 飞书能力依赖外部 `lark-cli`，不同版本的命令和权限可能变化。
- CC Switch 的本地设置格式可能随版本变化；本项目通过 `ccSwitch.settingsPath` 保持可配置，并允许关闭 CC Switch 指纹。
- 截图和桌面自动化主要面向 Windows；非 Windows 环境需要自行替换截图适配器。
- 这不是远程桌面或沙箱。Codex 仍以当前用户权限执行命令，请使用独立工作目录、白名单，并定期审查产物和日志。
- 不要把这个桥接暴露给不受信任的用户或群聊。

## 故障排查

### API 实调失败

先运行：

```powershell
npm run model-check
```

查看当前模型、供应商、端点和错误信息。不要靠重启掩盖配置错误。

### Telegram 收不到消息

检查 Bot Token、白名单、代理和轮询状态。发送「状态」查看健康卡；轮询失败会自动重试。

### 飞书没有回复

检查 `lark-cli` 是否安装、应用身份是否正确、`event status` 是否显示消费者运行。

### 截图失败

确认 Windows 处于解锁状态、存在交互桌面，并且运行桥接的进程和截图脚本在同一个用户会话中。

## 贡献与许可

欢迎提交 Issue 和 Pull Request。提交前请阅读 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)，不要上传真实配置、日志或截图。

MIT License，见 [LICENSE](LICENSE)。

# 官方 API、自建 API 与中转站

[**简体中文**](API_PROVIDERS.zh-CN.md) | [English](API_PROVIDERS.md)

桥接不实现具体模型供应商，而是调用 Codex CLI，并跟随 Codex 当前配置。因此同一个桥接可以连接：

- OpenAI 官方 API、ChatGPT/Codex 登录；
- 自建的 OpenAI 兼容网关；
- 第三方中转站；
- 由 CC Switch 或其他工具管理的本地代理。

桥接跟随 Codex/CC Switch 中选择的供应商和模型，不会强制使用内置模型。

## 任意供应商的接入条件

在使用前，当前 Codex 配置必须满足：

1. 有有效的供应商和模型；
2. 认证/API 凭据可用；
3. 支持已安装 Codex CLI 所需的接口协议；
4. 配置的模型名称在服务端真实存在；
5. 运行桥接的电脑可以访问该服务。

使用中转站时，请原样填写服务商提供的 Base URL 和模型名。中转站必须支持 Codex 当前使用的协议，而不只是提供一个聊天网页。

## 推荐配置方式

建议在 CC Switch 中为每个 API 建立独立供应商条目：

```text
官方 API
自有 API / 自建网关
中转站 A
中转站 B
```

每个条目配置：

- 供应商名称；
- Base URL；
- 模型 slug；
- API 凭据；
- Codex 或中转站要求的接口兼容选项。

优先使用 CC Switch UI 或供应商提供的 Codex 配置说明。不要猜 `wire_api`：有的中转站支持 Responses API，有的只支持 Chat Completions，还有的只实现部分能力。

一个概念示例（字段取决于 Codex 版本和中转站）：

```toml
model_provider = "relay"
model = "your-relay-model"

[model_providers.relay]
name = "My Relay"
base_url = "https://relay.example.com/v1"
wire_api = "responses"
```

凭据放在 CC Switch、Codex 认证存储或环境变量中，不要写入仓库。

## 验证供应商

配置完成后，在仓库目录运行：

```powershell
npm run model-check
```

命令会用当前配置发起最小真实 Codex 调用，并显示：

- 供应商名称；
- 模型；
- 脱敏后的 Base URL；
- 延迟；
- 失败时的脱敏错误。

端口可连接或 HTTP 200 都不够，模型必须真实返回有效结果。

## 在自有 API 和中转站之间切换

1. 在 CC Switch 选择另一个供应商；
2. CC Switch 更新 Codex 配置、认证或当前供应商 ID；
3. 桥接检测到配置指纹变化；
4. 作废旧模型绑定的会话；
5. 等待配置稳定；
6. 用新配置执行真实模型调用；
7. 成功后才接受下一项任务；
8. 已启用渠道会收到结果通知。

正常供应商切换不需要编辑 `bridge.js`，也不需要重启桥接。

如果新中转站配置错误，任务会被阻止，健康状态会降级。桥接不会把旧供应商实调成功的结果当作新供应商的通过证据。

## 安全与隐私

中转站可以看到提示词、模型上下文和模型响应。请只用可信服务处理你的数据：

- 不要把密钥写进任务正文或 Git；
- 为不同供应商使用可独立吊销的 Key；
- 了解中转站的日志、保留和隐私政策；
- 桥接会对本地记录中的常见凭据做脱敏，但不应主动把密钥发给模型；
- 供应商和中转站配置属于外部安全边界。

## 故障排查

| 现象 | 可能原因 |
|---|---|
| 401/403 | 凭据错误或过期 |
| 404 model | 中转站没有这个模型 slug |
| 不支持 endpoint | 中转站没有实现 Codex 所需协议 |
| 超时 | 代理、DNS、防火墙或中转站故障 |
| 切换后会话失败 | 旧会话未失效；桥接会自动清理 |
| `model-check` 成功但任务失败 | 任务本身失败，检查工具证据和报告 |

更换供应商后，先运行 `npm run model-check`，再发一个简单的只读任务，确认稳定后再用于重要工作。

# 贡献指南

[**简体中文**](CONTRIBUTING.zh-CN.md) | [English](CONTRIBUTING.md)

## 提交 PR 前

1. 不要包含真实凭据、个人 ID、聊天记录、截图或下载文件。
2. 运行 `npm run selftest`。
3. 运行 `npm run security:scan`。
4. 平台相关行为应通过配置或明确的平台判断处理。
5. 新增配置项时同步更新 `README.md`、`README.zh-CN.md` 和 `config.example.json`。
6. 修改安全门禁时补充测试或扩展自检。

## 提交信息

使用简短、明确的提交信息：

```text
feat: add configurable Telegram proxy
fix: redact authorization headers from history
docs: explain CC Switch live probe
```

## Pull Request 检查清单

- [ ] 没有包含任何凭据或私有运行文件。
- [ ] 自检通过。
- [ ] 凭据扫描通过。
- [ ] 配置保持向后兼容，或在文档中说明变更。
- [ ] 失败状态仍然明确，没有新增误报成功的路径。
- [ ] GUI、文件和远程任务仍然要求用户可见证据。

## 开发环境

```powershell
npm install
Copy-Item config.example.json config.json
npm run selftest
npm run security:scan
```

如需进行真实模型检查，请在本机配置 Codex/CC Switch 后运行：

```powershell
npm run model-check
```

不要提交生成的 `config.json` 或 `data/` 目录。

---
name: im
description: 管理 pi 的 IM 机器人（Telegram / 飞书 / 钉钉）。当用户提到"绑定机器人"、"IM 机器人"、"飞书机器人"、"钉钉机器人"、"telegram bot"、"扫码接入"等时使用。
---

# pi-im 机器人管理

本技能描述如何通过 `/im` 命令帮用户管理 IM 机器人接入。

## 渠道与接入方式

| 渠道 | 接入方式 | 凭据 |
|---|---|---|
| Telegram | @BotFather 创建 bot 后粘贴 token | `token` |
| 飞书 | 扫码创建（推荐）或手动 App ID + Secret | `appId`, `appSecret` |
| 钉钉 | 扫码设备注册（推荐）或手动 Client ID + Secret | `clientId`, `clientSecret` |
| 企业微信 | 扫码创建智能机器人（推荐）或 Bot ID + Secret | `botId`, `secret` |
| QQ | 扫码创建（推荐）或 AppID + AppSecret | `appId`, `appSecret` |
| Slack | 自建 App（Socket Mode + 事件订阅）后填双 token | `botToken`, `appToken` |
| Discord | Developer Portal 创建 bot，需开 Message Content Intent | `token` |
| WhatsApp | 手机 WhatsApp「已关联设备」扫码，仅响应自聊 | 会话密钥（自动保存） |
| iMessage | 仅 macOS：需完全磁盘访问 + 自动化权限 | 无（本机身份） |
| 微信个人号 | 手机微信扫码登录（可能需配对码验证） | `token`, `accountId`, `baseUrl` |

## 指引用户操作

1. 让用户在 pi 中运行 `/im`（或 `/im bind`）开始交互式绑定；
2. 扫码流程会展示终端二维码并自动打开 PNG 大图，用户用对应 App 扫码确认；
3. 绑定成功后机器人自动上线，凭据保存在 `~/.pi/im/config.json`（权限 600，勿在对话中读取或展示其内容）；
4. 用户在 IM 中发消息会注入当前 pi 会话，回复自动发回原聊天。

## IM 侧内置命令

- `/new` 开新会话 · `/stop` 停止任务 · `/status` 状态 · `/steer <内容>` 插话 · `/help` 帮助

## 常见问题

- **连接失败**：检查凭据与网络（Telegram 需能访问 api.telegram.org；可先设 `HTTPS_PROXY` 再启动 pi）。
- **群聊不回复**：飞书/Slack/Discord 群聊仅响应 @机器人；Telegram 群聊需以 `/命令@botname` 或私聊交互。
- **钉钉提示缺 webhook**：机器人需先收到过某会话消息才能向该会话主动发送。
- **WhatsApp 收不到消息**：默认仅响应账号自聊——用户需在 WhatsApp 里给自己发消息。
- **iMessage 权限**：提示完全磁盘访问/自动化权限时，引导用户去 系统设置 → 隐私与安全性 授权后重试 `/im connect imessage`。
- **Discord 401/intents 报错**：Developer Portal → Bot → 开启 Message Content Intent。
- **微信提示凭据失效**：微信号在其他设备登录会使 token 失效（服务端 ret=-14），需 `/im remove` 后重新扫码。
- **微信要求配对码**：绑定流程会自动弹出输入框，输入手机微信展示的 4-8 位数字即可。
- **凭据安全**：Secret 只落本机文件，任何情况下不要把 `config.json` 内容输出到对话或日志。

/**
 * pi-im 扩展入口：扫码绑定 IM 机器人并桥接到 pi 会话。
 *
 * 命令：
 *   /im                — 交互式管理（列表/绑定/连接/断开/移除）
 *   /im bind           — 绑定新机器人（telegram token / 飞书扫码 / 钉钉扫码）
 *   /im list|status    — 查看机器人与连接状态
 *   /im connect|disconnect <channel> [botId]
 *   /im remove <channel> <botId>
 *   /im test           — 向最近聊天发送连接测试消息
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ImBridge } from "../src/bridge.js";
import { DingtalkRuntime } from "../src/channels/dingtalk.js";
import { dingtalkQrPoll, dingtalkQrStart } from "../src/channels/dingtalk-device-auth.js";
import { DiscordRuntime } from "../src/channels/discord.js";
import { FeishuRuntime } from "../src/channels/feishu.js";
import { registerFeishuApp } from "../src/channels/feishu-registration.js";
import { IMessageRuntime } from "../src/channels/imessage.js";
import { QqRuntime } from "../src/channels/qq.js";
import { SlackRuntime } from "../src/channels/slack.js";
import { TelegramRuntime } from "../src/channels/telegram.js";
import { WecomRuntime } from "../src/channels/wecom.js";
import { wecomQrPoll, wecomQrStart } from "../src/channels/wecom-qr-auth.js";
import { WeixinRuntime } from "../src/channels/weixin.js";
import { weixinBeginLogin, weixinPollLogin } from "../src/channels/weixin-api.js";
import { WhatsappRuntime } from "../src/channels/whatsapp.js";
import { listBots, removeBot, saveBot } from "../src/store.js";
import { registerDeliveryTools } from "../src/delivery.js";
import type { BotConfig, ChannelId, ChannelRuntime, InboundMessage, RuntimeLogger } from "../src/types.js";
import { showQrOverlay } from "../src/ui.js";

const log: RuntimeLogger = {
	info: (...a) => console.log(...a),
	warn: (...a) => console.warn(...a),
	error: (...a) => console.error(...a),
};

export default function imExtension(pi: ExtensionAPI): void {
	const bridge = new ImBridge(pi, log);
	bridge.wire();
	// 主动投递工具：im_bots / im_send（供 agent 与其他扩展如 daily-news 调用）
	registerDeliveryTools(pi, { runtimes: () => bridge.listRuntimes(), registry: bridge.deliveryRegistry });
	/** 活跃运行时，session_shutdown 时统一停止 */
	const running = new Map<string, { runtime: ChannelRuntime; stop: () => Promise<void> }>();

	async function startBot(bot: BotConfig, ctx?: ExtensionCommandContext): Promise<void> {
		const key = `${bot.channel}:${bot.botId}`;
		if (running.has(key)) return;
		const handler = (msg: InboundMessage) => bridge.handleInbound(msg);
		let runtime: ChannelRuntime;
		let postStart: (() => Promise<void>) | undefined;

		if (bot.channel === "telegram") {
			const rt = new TelegramRuntime(bot, handler, log);
			const username = await rt.verify();
			if (username !== bot.botId) {
				bot.botId = username;
				bot.name = bot.name || username;
				await saveBot(bot);
			}
			runtime = rt;
		} else if (bot.channel === "feishu") {
			const rt = new FeishuRuntime(bot, handler, log);
			const name = await rt.verify().catch(() => bot.name);
			bot.name = bot.name || name;
			runtime = rt;
		} else if (bot.channel === "dingtalk") {
			const rt = new DingtalkRuntime(bot, handler, log);
			await rt.verify();
			runtime = rt;
		} else if (bot.channel === "wecom") {
			const rt = new WecomRuntime(bot, handler, log);
			await rt.verify();
			runtime = rt;
		} else if (bot.channel === "qq") {
			const rt = new QqRuntime(bot, handler, log);
			await rt.verify();
			runtime = rt;
		} else if (bot.channel === "slack") {
			const rt = new SlackRuntime(bot, handler, log);
			const name = await rt.verify();
			bot.name = bot.name || name;
			bot.botId = `${bot.credentials.botToken.slice(4, 12)}…`;
			runtime = rt;
		} else if (bot.channel === "discord") {
			const rt = new DiscordRuntime(bot, handler, log);
			const username = await rt.verify();
			bot.name = bot.name || username;
			bot.botId = bot.botId || username;
			runtime = rt;
		} else if (bot.channel === "whatsapp") {
			const rt = new WhatsappRuntime(bot, handler, log);
			await rt.verify();
			runtime = rt;
		} else if (bot.channel === "imessage") {
			const rt = new IMessageRuntime(bot, handler, log);
			await rt.verify();
			runtime = rt;
		} else if (bot.channel === "weixin") {
			const rt = new WeixinRuntime(bot, handler, log);
			await rt.verify();
			runtime = rt;
		} else {
			throw new Error(`未知渠道 ${bot.channel}`);
		}

		bridge.registerRuntime(runtime);
		try {
			await runtime.start();
			running.set(key, { runtime, stop: () => runtime.stop() });
			const note = `${bot.channel} 机器人 ${bot.name || bot.botId} 已上线 ✅`;
			ctx?.ui.notify(note, "info");
			log.info(`[pi-im] ${note}`);
		} catch (err) {
			bridge.unregisterRuntime(runtime);
			throw err;
		}
		void postStart?.();
	}

	async function stopBot(channel: ChannelId, botId: string): Promise<void> {
		const key = `${channel}:${botId}`;
		const entry = running.get(key);
		if (!entry) return;
		await entry.stop();
		bridge.unregisterRuntime(entry.runtime);
		running.delete(key);
	}

	async function stopAll(): Promise<void> {
		for (const [key, entry] of [...running]) {
			await entry.stop().catch(() => {});
			bridge.unregisterRuntime(entry.runtime);
			running.delete(key);
		}
	}

	// ---------- 绑定流程 ----------

	async function bindTelegram(ctx: ExtensionCommandContext): Promise<void> {
		const token = await ctx.ui.input("Telegram Bot Token", "粘贴 @BotFather 颁发的 token（123456:ABC-...）");
		if (!token?.trim()) return;
		const bot: BotConfig = { channel: "telegram", botId: "", name: "", credentials: { token: token.trim() }, enabled: true };
		ctx.ui.notify("正在验证 token…", "info");
		const rt = new TelegramRuntime(bot, (m) => bridge.handleInbound(m), log);
		const username = await rt.verify();
		bot.botId = username;
		bot.name = username;
		await saveBot(bot);
		await startBot(bot, ctx);
		ctx.ui.notify(`Telegram 机器人 @${username} 绑定成功 ✅`, "info");
	}

	async function bindFeishu(ctx: ExtensionCommandContext): Promise<void> {
		const mode = await ctx.ui.select("飞书接入方式", ["扫码创建机器人（推荐）", "手动输入 App ID + App Secret"]);
		if (!mode) return;

		let bot: BotConfig | null = null;
		if (mode.startsWith("扫码")) {
			let qrShown = false;
			const done = new Promise<void>((resolve, reject) => {
				void registerFeishuApp({
					onSnapshot: async (snap) => {
						if (snap.state === "qr_ready" && snap.qrCodeUrl && !qrShown) {
							qrShown = true;
							await showQrOverlay(ctx, "使用飞书 App 扫码并确认授权", snap.qrCodeUrl);
						} else if (snap.state === "polling") {
							ctx.ui.notify("等待扫码确认…（二维码 5 分钟内有效）", "info");
						} else if (snap.state === "succeeded") {
							resolve();
						} else if (snap.state === "expired") {
							reject(new Error("二维码已过期，请重新绑定"));
						} else if (snap.state === "error") {
							reject(new Error(snap.error ?? "飞书注册失败"));
						}
					},
					onCredentials: async (creds) => {
						bot = {
							channel: "feishu",
							botId: creds.appId,
							name: creds.botName ?? "",
							credentials: { appId: creds.appId, appSecret: creds.appSecret },
							enabled: true,
						};
						await saveBot(bot);
					},
				}).catch(reject);
			});
			await done;
			if (!bot) throw new Error("飞书注册未返回凭据");
		} else {
			const appId = await ctx.ui.input("飞书 App ID", "cli_xxx");
			const appSecret = await ctx.ui.input("飞书 App Secret", "");
			if (!appId?.trim() || !appSecret?.trim()) return;
			bot = {
				channel: "feishu",
				botId: appId.trim(),
				name: "",
				credentials: { appId: appId.trim(), appSecret: appSecret.trim() },
				enabled: true,
			};
			await saveBot(bot);
		}
		await startBot(bot, ctx);
		ctx.ui.notify(`飞书机器人 ${bot.name || bot.botId} 绑定成功 ✅`, "info");
	}

	async function bindDingtalk(ctx: ExtensionCommandContext): Promise<void> {
		const mode = await ctx.ui.select("钉钉接入方式", ["扫码创建机器人（推荐）", "手动输入 Client ID + Client Secret"]);
		if (!mode) return;

		let bot: BotConfig | null = null;
		if (mode.startsWith("扫码")) {
			ctx.ui.notify("正在申请钉钉注册二维码…", "info");
			const qr = await dingtalkQrStart();
			await showQrOverlay(ctx, "使用钉钉 App 扫码并确认授权", qr.verificationUrl);

			const deadline = qr.expiresAt;
			let creds: { clientId: string; clientSecret: string } | null = null;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, qr.pollIntervalMs));
				const res = await dingtalkQrPoll(qr.deviceCode);
				if (res.status === "SUCCESS") {
					creds = { clientId: res.clientId, clientSecret: res.clientSecret };
					break;
				}
				if (res.status === "EXPIRED") throw new Error("二维码已过期，请重新绑定");
				if (res.status === "FAIL") throw new Error(`钉钉注册失败: ${res.failReason ?? "未知原因"}`);
			}
			if (!creds) throw new Error("钉钉注册超时，请重新绑定");
			bot = {
				channel: "dingtalk",
				botId: creds.clientId,
				name: "",
				credentials: { clientId: creds.clientId, clientSecret: creds.clientSecret },
				enabled: true,
			};
			await saveBot(bot);
		} else {
			const clientId = await ctx.ui.input("钉钉 Client ID", "");
			const clientSecret = await ctx.ui.input("钉钉 Client Secret", "");
			if (!clientId?.trim() || !clientSecret?.trim()) return;
			bot = {
				channel: "dingtalk",
				botId: clientId.trim(),
				name: "",
				credentials: { clientId: clientId.trim(), clientSecret: clientSecret.trim() },
				enabled: true,
			};
			await saveBot(bot);
		}
		if (!bot) throw new Error("钉钉注册未返回凭据");
		await startBot(bot, ctx);
		ctx.ui.notify(`钉钉机器人 ${bot.botId} 绑定成功 ✅`, "info");
	}

	// ---------- 新增渠道绑定流程 ----------

	/** 通用轮询器：扫码注册 until success/expire */
	async function pollUntil<T>(
		fn: () => Promise<{ status: string } & Record<string, unknown>>,
		opts: { intervalMs: number; deadline: number },
	): Promise<Record<string, unknown> | null> {
		while (Date.now() < opts.deadline) {
			await new Promise((r) => setTimeout(r, opts.intervalMs));
			const res = (await fn()) as { status: string } & Record<string, unknown>;
			if (res.status === "SUCCESS") return res;
			if (res.status === "EXPIRED") throw new Error("二维码已过期，请重新绑定");
			if (res.status === "FAILED") throw new Error("扫码注册失败，请重试");
		}
		throw new Error("扫码注册超时，请重新绑定");
	}

	async function bindWecom(ctx: ExtensionCommandContext): Promise<void> {
		const mode = await ctx.ui.select("企业微信接入方式", ["扫码创建智能机器人（推荐）", "手动输入 Bot ID + Secret"]);
		if (!mode) return;
		let bot: BotConfig | null = null;
		if (mode.startsWith("扫码")) {
			ctx.ui.notify("正在申请企业微信注册二维码…", "info");
			const qr = await wecomQrStart();
			await showQrOverlay(ctx, "使用企业微信 App 扫码并确认授权", qr.verificationUrl);
			const res = (await pollUntil(() => wecomQrPoll(qr.scode), {
				intervalMs: qr.pollIntervalMs,
				deadline: qr.expiresAt,
			})) as { status: "SUCCESS"; botId: string; secret: string };
			bot = {
				channel: "wecom",
				botId: String(res.botId),
				name: "",
				credentials: { botId: String(res.botId), secret: String(res.secret) },
				enabled: true,
			};
			await saveBot(bot);
		} else {
			const botId = await ctx.ui.input("企业微信 Bot ID", "");
			const secret = await ctx.ui.input("企业微信 Secret", "");
			if (!botId?.trim() || !secret?.trim()) return;
			bot = {
				channel: "wecom",
				botId: botId.trim(),
				name: "",
				credentials: { botId: botId.trim(), secret: secret.trim() },
				enabled: true,
			};
			await saveBot(bot);
		}
		if (!bot) throw new Error("企业微信注册未返回凭据");
		await startBot(bot, ctx);
		ctx.ui.notify(`企业微信机器人绑定成功 ✅`, "info");
	}

	async function bindQq(ctx: ExtensionCommandContext): Promise<void> {
		const mode = await ctx.ui.select("QQ 接入方式", ["扫码创建机器人（推荐）", "手动输入 AppID + AppSecret"]);
		if (!mode) return;
		let bot: BotConfig | null = null;
		if (mode.startsWith("扫码")) {
			const { startQrConnect } = await import("@tencent-connect/qqbot-connector");
			ctx.ui.notify("正在申请 QQ 注册二维码…", "info");
			await new Promise<void>((resolve, reject) => {
				const ac = new AbortController();
				const stop = startQrConnect(
					{
						onQrDisplayed: (url) => {
							void showQrOverlay(ctx, "使用手机 QQ 扫码并确认授权", url);
						},
						onSuccess: (creds) => {
							void (async () => {
								try {
									const c = creds[0];
									if (!c) throw new Error("QQ 注册未返回凭据");
									bot = {
										channel: "qq",
										botId: c.appId,
										name: "",
										credentials: { appId: c.appId, appSecret: c.appSecret },
										enabled: true,
									};
									await saveBot(bot);
									resolve();
								} catch (err) {
									reject(err as Error);
								}
							})();
						},
						onFailure: (err) => reject(err),
					},
					{ displayQrCodeToConsole: false, signal: ac.signal, source: "pi-im" },
				);
				void stop;
			});
		} else {
			const appId = await ctx.ui.input("QQ AppID", "");
			const appSecret = await ctx.ui.input("QQ AppSecret", "");
			if (!appId?.trim() || !appSecret?.trim()) return;
			bot = {
				channel: "qq",
				botId: appId.trim(),
				name: "",
				credentials: { appId: appId.trim(), appSecret: appSecret.trim() },
				enabled: true,
			};
			await saveBot(bot);
		}
		if (!bot) throw new Error("QQ 注册未返回凭据");
		await startBot(bot, ctx);
		ctx.ui.notify(`QQ 机器人 ${bot.botId} 绑定成功 ✅`, "info");
	}

	async function bindSlack(ctx: ExtensionCommandContext): Promise<void> {
		const botToken = await ctx.ui.input("Slack Bot Token", "xoxb-…（从 App OAuth Tokens 获取）");
		if (!botToken?.trim()) return;
		const appToken = await ctx.ui.input("Slack App Token", "xapp-…（Socket Mode，需 connections:write）");
		if (!appToken?.trim()) return;
		const bot: BotConfig = {
			channel: "slack",
			botId: "",
			name: "",
			credentials: { botToken: botToken.trim(), appToken: appToken.trim() },
			enabled: true,
		};
		await saveBot(bot);
		await startBot(bot, ctx);
		ctx.ui.notify(`Slack 机器人绑定成功 ✅（记得安装 App 到工作区并开启 Socket Mode）`, "info");
	}

	async function bindDiscord(ctx: ExtensionCommandContext): Promise<void> {
		const token = await ctx.ui.input("Discord Bot Token", "Developer Portal → Bot → Reset Token");
		if (!token?.trim()) return;
		const bot: BotConfig = {
			channel: "discord",
			botId: "",
			name: "",
			credentials: { token: token.trim() },
			enabled: true,
		};
		await saveBot(bot);
		await startBot(bot, ctx);
		ctx.ui.notify(
			`Discord 机器人绑定成功 ✅（需在 Developer Portal 开启 Message Content Intent）`,
			"info",
		);
	}

	async function bindWhatsapp(ctx: ExtensionCommandContext): Promise<void> {
		const ok = await ctx.ui.confirm(
			"WhatsApp 关联设备",
			"将弹出二维码，用手机 WhatsApp → 已关联设备 扫码。凭据保存在本机 ~/.pi/im/whatsapp-session/。",
		);
		if (!ok) return;
		const bot: BotConfig = { channel: "whatsapp", botId: "me", name: "", credentials: {}, enabled: true };
		await saveBot(bot);
		await startBot(bot, ctx);
		ctx.ui.notify("WhatsApp 已关联 ✅（默认仅响应账号自聊消息，给自己发消息即可与 pi 对话）", "info");
	}

	async function bindImessage(ctx: ExtensionCommandContext): Promise<void> {
		const bot: BotConfig = { channel: "imessage", botId: "local", name: "", credentials: {}, enabled: true };
		await saveBot(bot);
		await startBot(bot, ctx);
		ctx.ui.notify("iMessage 已上线 ✅（回复将带 🤖 pi-im 前缀，避免回声循环）", "info");
	}

	async function bindWeixin(ctx: ExtensionCommandContext): Promise<void> {
		const { openImageUrl } = await import("../src/ui.js");
		ctx.ui.notify("正在申请微信登录二维码…", "info");
		// 带上已有微信账号的 local_token，避免同账号重复配对
		const existing = (await listBots()).filter((b) => b.channel === "weixin").map((b) => b.credentials.token);
		const login = await weixinBeginLogin({ localTokens: existing });
		await openImageUrl(ctx, "使用微信扫码（手机微信 → 扫一扫），然后在微信中确认登录", login.qrcodeUrl);

		let baseUrl: string | undefined;
		let verifyCode: string | undefined;
		let notifiedVerify = false;
		const deadline = Date.now() + 5 * 60_000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2_000));
			const res = await weixinPollLogin({ qrcode: login.qrcode, baseUrl, verifyCode });
			if (res.status === "wait") continue;
			if (res.status === "redirect") {
				baseUrl = res.baseUrl;
				continue;
			}
			if (res.status === "scaned") {
				notifiedVerify = false;
				ctx.ui.notify("已扫码，请在手机上确认登录…", "info");
				continue;
			}
			if (res.status === "need_verifycode") {
				if (!notifiedVerify) {
					notifiedVerify = true;
					ctx.ui.notify("微信要求配对码验证，请在 pi 中输入弹出的配对码", "warning");
				}
				const code = await ctx.ui.input("请输入微信展示的配对码（4-8 位数字）", "1234");
				if (!code?.trim()) return;
				verifyCode = code.trim();
				continue;
			}
			if (res.status === "verify_code_blocked") throw new Error("配对码多次错误，请重新发起绑定");
			if (res.status === "expired") throw new Error("二维码已过期，请重新绑定");
			if (res.status === "binded_redirect") {
				throw new Error("该微信账号已在别处绑定；若要迁到本机，请先在原设备退出或删除原凭据后重试");
			}
			if (res.status === "confirmed") {
				const bot: BotConfig = {
					channel: "weixin",
					botId: res.accountId,
					name: "微信个人号",
					credentials: {
						token: res.token,
						accountId: res.accountId,
						ownerUserId: res.ownerUserId,
						baseUrl: res.baseUrl,
					},
					enabled: true,
				};
				await saveBot(bot);
				await startBot(bot, ctx);
				ctx.ui.notify("微信个人号已上线 ✅（在微信中给该账号发消息即可与 pi 对话）", "info");
				return;
			}
		}
		throw new Error("微信扫码登录超时，请重新绑定");
	}

	// ---------- /im 命令 ----------

	pi.registerCommand("im", {
		description: "IM 机器人管理：绑定/连接/断开/移除",
		handler: async (args, ctx) => {
			bridge.captureCommandContext(ctx);
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0];

			if (!sub) {
				const action = await ctx.ui.select(
					"pi-im 管理",
					["绑定新机器人", "查看状态", "连接全部", "断开全部", "连接测试", "移除机器人"],
				);
				if (!action) return;
				if (action === "绑定新机器人") return bindFlow(ctx);
				if (action === "查看状态") return statusReport(ctx);
				if (action === "连接全部") return connectAll(ctx);
				if (action === "断开全部") return stopAll().then(() => ctx.ui.notify("已断开全部机器人", "info"));
				if (action === "连接测试") return testConnections(ctx);
				if (action === "移除机器人") return removeFlow(ctx);
				return;
			}
			switch (sub) {
				case "bind":
					return bindFlow(ctx);
				case "list":
				case "status":
					return statusReport(ctx);
				case "connect": {
					const bots = await listBots();
					const targets = bots.filter((b) => !parts[1] || b.channel === parts[1]);
					for (const b of targets) {
						try {
							await startBot(b, ctx);
						} catch (err) {
							ctx.ui.notify(`${b.channel}:${b.botId} 连接失败: ${(err as Error).message}`, "error");
						}
					}
					return;
				}
				case "disconnect": {
					for (const key of [...running.keys()]) {
						if (!parts[1] || key.startsWith(parts[1])) {
							const [ch, id] = key.split(":");
							await stopBot(ch as ChannelId, id);
						}
					}
					ctx.ui.notify("已断开", "info");
					return;
				}
				case "remove":
					return removeFlow(ctx);
				case "test":
					return testConnections(ctx);
				default:
					ctx.ui.notify("用法: /im [bind|list|connect|disconnect|remove|test]", "info");
			}
		},
	});

	async function bindFlow(ctx: ExtensionCommandContext): Promise<void> {
		const chosen = await ctx.ui.select(
			"选择渠道",
			[
				"telegram — Bot Token",
				"feishu — 飞书（扫码/凭据）",
				"dingtalk — 钉钉（扫码/凭据）",
				"wecom — 企业微信（扫码/凭据）",
				"qq — QQ（扫码/凭据）",
				"slack — Slack（Socket Mode）",
				"discord — Discord（Bot Token）",
				"whatsapp — WhatsApp（扫码关联）",
				"imessage — iMessage（仅 macOS）",
				"weixin — 微信个人号（扫码登录）",
			],
		);
		if (!chosen) return;
		if (chosen.startsWith("telegram")) return bindTelegram(ctx);
		if (chosen.startsWith("feishu")) return bindFeishu(ctx);
		if (chosen.startsWith("dingtalk")) return bindDingtalk(ctx);
		if (chosen.startsWith("wecom")) return bindWecom(ctx);
		if (chosen.startsWith("qq")) return bindQq(ctx);
		if (chosen.startsWith("slack")) return bindSlack(ctx);
		if (chosen.startsWith("discord")) return bindDiscord(ctx);
		if (chosen.startsWith("whatsapp")) return bindWhatsapp(ctx);
		if (chosen.startsWith("imessage")) return bindImessage(ctx);
		if (chosen.startsWith("weixin")) return bindWeixin(ctx);
	}

	async function statusReport(ctx: ExtensionCommandContext): Promise<void> {
		const bots = await listBots();
		const lines: string[] = ["pi-im 机器人："];
		for (const b of bots) {
			const key = `${b.channel}:${b.botId}`;
			const rt = bridge.listRuntimes().find((r) => `${r.channel}:${r.botId}` === key);
			lines.push(`- [${b.channel}] ${b.name || b.botId} — ${rt?.healthy() ? "✅ 在线" : "⏸ 离线"}`);
		}
		if (!bots.length) lines.push("（暂无机器人，使用 /im bind 绑定）");
		ctx.ui.notify(lines.join("\n"), "info");
		updateWidget(ctx);
	}

	async function connectAll(ctx: ExtensionCommandContext): Promise<void> {
		const bots = await listBots();
		for (const b of bots) {
			try {
				await startBot(b, ctx);
			} catch (err) {
				ctx.ui.notify(`${b.channel}:${b.botId} 连接失败: ${(err as Error).message}`, "error");
			}
		}
		updateWidget(ctx);
	}

	async function testConnections(ctx: ExtensionCommandContext): Promise<void> {
		let sent = 0;
		for (const rt of bridge.listRuntimes()) {
			const withTest = rt as typeof rt & { sendTest?: (t: string) => Promise<boolean> };
			if (withTest.sendTest) {
				try {
					if (await withTest.sendTest("pi-im 连接测试成功 ✅")) sent++;
				} catch (err) {
					ctx.ui.notify(`${rt.channel}:${rt.botId} 测试发送失败: ${(err as Error).message}`, "warning");
				}
			}
		}
		ctx.ui.notify(sent ? `已向 ${sent} 个机器人最近聊天发送测试消息` : "尚无可用的测试会话（机器人需先收到过消息）", sent ? "info" : "warning");
	}

	async function removeFlow(ctx: ExtensionCommandContext): Promise<void> {
		const bots = await listBots();
		if (!bots.length) return ctx.ui.notify("暂无机器人", "warning");
		const label = (b: BotConfig) => `${b.channel} · ${b.name || b.botId}`;
		const chosen = await ctx.ui.select("移除哪个机器人？", bots.map(label));
		if (!chosen) return;
		const bot = bots.find((b) => label(b) === chosen);
		if (!bot) return;
		const ok = await ctx.ui.confirm("确认移除", `将移除 ${label(bot)} 并删除其凭据。`);
		if (!ok) return;
		await stopBot(bot.channel, bot.botId);
		await removeBot(bot.channel, bot.botId);
		ctx.ui.notify(`已移除 ${label(bot)}`, "info");
		updateWidget(ctx);
	}

	/** 最近命令上下文，用于设置 widget */
	let lastUiCtx: { ui: { setWidget: (k: string, c: string[] | undefined) => void } } | null = null;

	/** 状态 widget：显示在线机器人 */
	function updateWidget(ctx?: ExtensionCommandContext): void {
		if (ctx) lastUiCtx = ctx;
		const rts = bridge.listRuntimes();
		const content = rts.length
			? [`🔗 IM: ${rts.filter((r) => r.healthy()).length}/${rts.length} 在线 (${rts.map((r) => r.channel).join(",")})`]
			: undefined;
		try {
			lastUiCtx?.ui.setWidget("pi-im", content);
		} catch {
			// 非 TUI 模式忽略
		}
	}

	// ---------- 生命周期 ----------

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode === "tui" || ctx.mode === "rpc") {
			const bots = await listBots();
			for (const b of bots) {
				if (!b.enabled) continue;
				try {
					await startBot(b);
				} catch (err) {
					log.warn(`[pi-im] ${b.channel}:${b.botId} 自动连接失败:`, (err as Error).message);
				}
			}
			updateWidget();
		}
	});

	pi.on("session_shutdown", async () => {
		await stopAll();
	});
}

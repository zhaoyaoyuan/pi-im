/**
 * 微信个人号 iLink 协议（bot_type=3 智能机器人）：移植自 dsh-im 的 weixin-api。
 *
 * 登录：get_bot_qrcode → get_qrcode_status 轮询（wait/scaned/confirmed/expired/
 * scaned_but_redirect/binded_redirect/need_verifycode/verify_code_blocked）
 * confirmed 后得到 bot_token + ilink_bot_id + ilink_user_id + baseurl。
 * 收发：notifystart → getupdates 长轮询 → sendmessage；ret=-14 表示凭据失效。
 *
 * 安全：所有请求主机限制在 *.weixin.qq.com / *.wechat.com（HTTPS 443）。
 */

import { randomBytes, randomUUID } from "node:crypto";

export const WEIXIN_QR_BASE_URL = "https://ilinkai.weixin.qq.com/";
export const WEIXIN_PROTOCOL_VERSION = "2.4.6";
export const DEFAULT_BOT_TYPE = "3";
const ILINK_APP_ID = "bot";
const ILINK_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
/** 微信单条消息上限，超过需分段 */
export const WEIXIN_MAX_MESSAGE_CHARS = 1_800;

const LOGIN_STATUSES = new Set([
	"wait",
	"scaned",
	"confirmed",
	"expired",
	"scaned_but_redirect",
	"need_verifycode",
	"verify_code_blocked",
	"binded_redirect",
]);

export class WeixinApiError extends Error {
	code: string;
	providerCode?: string;
	status?: number;

	constructor(code: string, message: string, options: { providerCode?: string; status?: number } = {}) {
		super(message);
		this.name = "WeixinApiError";
		this.code = code;
		this.providerCode = options.providerCode;
		this.status = options.status;
	}
}

function nonEmpty(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isWeixinHost(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/\.$/, "");
	return (
		normalized === "weixin.qq.com" ||
		normalized.endsWith(".weixin.qq.com") ||
		normalized === "wechat.com" ||
		normalized.endsWith(".wechat.com")
	);
}

/** 服务端下发的 API base（redirect_host）必须落在微信域内 */
export function normalizeWeixinApiBaseUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new WeixinApiError("invalid-base-url", "微信服务返回了无效的连接地址。");
	}
	if (url.protocol !== "https:" || !isWeixinHost(url.hostname) || (url.port !== "" && url.port !== "443")) {
		throw new WeixinApiError("untrusted-base-url", "微信服务返回了不受信任的连接地址。");
	}
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url.toString();
}

/** 扫码图片地址校验（返回的是二维码图片 URL，不是可渲染的内容） */
export function normalizeWeixinQrUrl(value: string): string {
	const text = nonEmpty(value);
	if (!text) throw new WeixinApiError("invalid-qr", "微信服务没有返回扫码地址。");
	try {
		const url = new URL(text);
		if (url.protocol !== "https:" || !isWeixinHost(url.hostname)) {
			throw new WeixinApiError("untrusted-qr", "微信服务返回了不受信任的扫码地址。");
		}
		return url.toString();
	} catch (err) {
		if (err instanceof WeixinApiError) throw err;
		throw new WeixinApiError("invalid-qr", "微信服务返回了无效的扫码地址。");
	}
}

function commonHeaders(): Record<string, string> {
	return {
		"iLink-App-Id": ILINK_APP_ID,
		"iLink-App-ClientVersion": String(ILINK_CLIENT_VERSION),
	};
}

function authenticatedHeaders(token: string): Record<string, string> {
	return {
		...commonHeaders(),
		"content-type": "application/json",
		AuthorizationType: "ilink_bot_token",
		"X-WECHAT-UIN": Buffer.from(randomBytes(4)).toString("base64"),
		Authorization: `Bearer ${token.trim()}`,
	};
}

export function weixinBaseInfo(): Record<string, string> {
	return {
		channel_version: WEIXIN_PROTOCOL_VERSION,
		bot_agent: "pi-im/1.0.0",
	};
}

/** 非零 errcode/ret 即拒绝；"-14" 表示凭据失效 */
export function rejectedProviderResponse(value: unknown, fields: string[] = ["ret", "errcode"]): string | null {
	if (!value || typeof value !== "object") return null;
	for (const field of fields) {
		const v = (value as Record<string, unknown>)[field];
		if (v !== undefined && v !== null && v !== 0 && v !== "0") return String(v);
	}
	return null;
}

async function requestJson(opts: {
	method: string;
	baseUrl: string;
	endpoint: string;
	body?: unknown;
	token?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	authenticated?: boolean;
}): Promise<Record<string, unknown>> {
	const trustedBase = normalizeWeixinApiBaseUrl(opts.baseUrl);
	const url = new URL(opts.endpoint, trustedBase);
	if (!isWeixinHost(url.hostname)) {
		throw new WeixinApiError("untrusted-endpoint", "拒绝访问不受信任的微信服务地址。");
	}
	const controller = new AbortController();
	const onAbort = () => controller.abort(opts.signal?.reason);
	if (opts.signal?.aborted) throw opts.signal.reason ?? new Error("aborted");
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			method: opts.method,
			headers: (opts.authenticated === false ? commonHeaders() : authenticatedHeaders(opts.token ?? "")),
			...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
			signal: controller.signal,
		});
		if (!res.ok) throw new WeixinApiError("http-error", `微信服务请求失败（HTTP ${res.status}）。`, { status: res.status });
		try {
			return (await res.json()) as Record<string, unknown>;
		} catch (err) {
			throw new WeixinApiError("invalid-response", "微信服务返回了无法解析的响应。", { status: undefined });
		}
	} catch (err) {
		if (opts.signal?.aborted) throw opts.signal.reason ?? err;
		if (err instanceof WeixinApiError) throw err;
		if (controller.signal.aborted && !opts.signal?.aborted) {
			throw new WeixinApiError("timeout", "微信服务请求超时。");
		}
		throw new WeixinApiError("network-error", "暂时无法访问微信服务。");
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

// ---------- 登录 ----------

export interface WeixinQrLogin {
	/** 二维码令牌（轮询用） */
	qrcode: string;
	/** 二维码图片 URL（展示用） */
	qrcodeUrl: string;
}

/** 申请登录二维码 */
export async function weixinBeginLogin(opts: {
	localTokens?: string[];
	botType?: string;
	signal?: AbortSignal;
}): Promise<WeixinQrLogin> {
	const tokens = [...new Set((opts.localTokens ?? []).map((t) => nonEmpty(t)).filter((t): t is string => Boolean(t)))].slice(-10);
	const response = await requestJson({
		method: "POST",
		baseUrl: WEIXIN_QR_BASE_URL,
		endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(opts.botType ?? DEFAULT_BOT_TYPE)}`,
		body: { local_token_list: tokens },
		timeoutMs: 10_000,
		signal: opts.signal,
		authenticated: false,
	});
	const qrcode = nonEmpty(response?.qrcode);
	const providerCode = rejectedProviderResponse(response);
	if (providerCode) throw new WeixinApiError("qr-request-rejected", "微信服务拒绝了二维码申请。", { providerCode });
	if (!qrcode) throw new WeixinApiError("invalid-qr", "微信服务没有返回二维码令牌。");
	return { qrcode, qrcodeUrl: normalizeWeixinQrUrl(String((response as Record<string, unknown>).qrcode_img_content ?? "")) };
}

export type WeixinLoginStatus =
	| { status: "wait" }
	| { status: "scaned" }
	| { status: "need_verifycode" }
	| { status: "verify_code_blocked" }
	| { status: "expired" }
	| { status: "binded_redirect" }
	| { status: "redirect"; baseUrl: string }
	| {
			status: "confirmed";
			token: string;
			accountId: string;
			ownerUserId: string;
			baseUrl: string;
	  };

/** 轮询一次扫码状态 */
export async function weixinPollLogin(opts: {
	qrcode: string;
	baseUrl?: string;
	verifyCode?: string;
	signal?: AbortSignal;
}): Promise<WeixinLoginStatus> {
	const base = opts.baseUrl ?? WEIXIN_QR_BASE_URL;
	let endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(opts.qrcode)}`;
	const verify = nonEmpty(opts.verifyCode);
	if (verify) endpoint += `&verify_code=${encodeURIComponent(verify)}`;
	const response = await requestJson({
		method: "GET",
		baseUrl: base,
		endpoint,
		timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
		signal: opts.signal,
		authenticated: false,
	});
	const status = nonEmpty((response as Record<string, unknown>).status);
	if (!status || !LOGIN_STATUSES.has(status)) {
		throw new WeixinApiError("invalid-login-status", "微信服务返回了无法识别的扫码状态。");
	}
	switch (status) {
		case "wait":
			return { status: "wait" };
		case "scaned":
			return { status: "scaned" };
		case "need_verifycode":
			return { status: "need_verifycode" };
		case "verify_code_blocked":
			return { status: "verify_code_blocked" };
		case "expired":
			return { status: "expired" };
		case "binded_redirect":
			return { status: "binded_redirect" };
		case "scaned_but_redirect": {
			const redirect = nonEmpty((response as Record<string, unknown>).redirect_host);
			if (!redirect) throw new WeixinApiError("invalid-login-status", "微信服务返回的重定向地址缺失。");
			return { status: "redirect", baseUrl: normalizeWeixinApiBaseUrl(redirect.includes("://") ? redirect : `https://${redirect}`) };
		}
		case "confirmed": {
			const token = nonEmpty((response as Record<string, unknown>).bot_token);
			const accountId = nonEmpty((response as Record<string, unknown>).ilink_bot_id);
			const ownerUserId = nonEmpty((response as Record<string, unknown>).ilink_user_id);
			if (!token || !accountId || !ownerUserId) {
				throw new WeixinApiError("incomplete-login", "微信授权成功，但返回的账号凭据不完整。");
			}
			const baseUrlRaw = nonEmpty((response as Record<string, unknown>).baseurl);
			const baseUrl = baseUrlRaw
				? normalizeWeixinApiBaseUrl(baseUrlRaw.includes("://") ? baseUrlRaw : `https://${baseUrlRaw}`)
				: normalizeWeixinApiBaseUrl(WEIXIN_QR_BASE_URL);
			return { status: "confirmed", token, accountId, ownerUserId, baseUrl };
		}
	}
	throw new WeixinApiError("invalid-login-status", "微信服务返回了无法识别的扫码状态。");
}

// ---------- 消息收发 ----------

/** 启动消息同步 */
export async function weixinNotifyStart(opts: { baseUrl: string; token: string; signal?: AbortSignal }): Promise<void> {
	const response = await requestJson({
		method: "POST",
		baseUrl: opts.baseUrl,
		endpoint: "ilink/bot/msg/notifystart",
		token: opts.token,
		timeoutMs: 10_000,
		signal: opts.signal,
		body: { base_info: weixinBaseInfo() },
	});
	const providerCode = rejectedProviderResponse(response);
	if (providerCode) {
		throw new WeixinApiError(providerCode === "-14" ? "stale-token" : "start-rejected", "微信账号连接启动失败。", { providerCode });
	}
}

/** 停止消息同步 */
export async function weixinNotifyStop(opts: { baseUrl: string; token: string; signal?: AbortSignal }): Promise<void> {
	const response = await requestJson({
		method: "POST",
		baseUrl: opts.baseUrl,
		endpoint: "ilink/bot/msg/notifystop",
		token: opts.token,
		timeoutMs: 10_000,
		signal: opts.signal,
		body: { base_info: weixinBaseInfo() },
	});
	const providerCode = rejectedProviderResponse(response);
	if (providerCode) throw new WeixinApiError("stop-rejected", "微信服务未确认停止通知。", { providerCode });
}

export interface WeixinUpdateMessage {
	msg_id?: string;
	from_user_id?: string;
	to_user_id?: string;
	context_token?: string;
	create_time_ms?: number;
	item_list?: {
		type?: number;
		text_item?: { text?: string };
		voice_item?: { text?: string };
	}[];
}

/** 长轮询一次增量消息；ret=-14 抛 stale-token */
export async function weixinGetUpdates(opts: {
	baseUrl: string;
	token: string;
	getUpdatesBuf?: string;
	signal?: AbortSignal;
}): Promise<{ msgs: WeixinUpdateMessage[]; getUpdatesBuf?: string }> {
	let response: Record<string, unknown>;
	try {
		response = await requestJson({
			method: "POST",
			baseUrl: opts.baseUrl,
			endpoint: "ilink/bot/getupdates",
			token: opts.token,
			timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
			signal: opts.signal,
			body: { get_updates_buf: opts.getUpdatesBuf ?? "", base_info: weixinBaseInfo() },
		});
	} catch (err) {
		if (err instanceof WeixinApiError && err.code === "timeout") {
			return { msgs: [], getUpdatesBuf: opts.getUpdatesBuf }; // 长轮询超时属正常
		}
		throw err;
	}
	const providerCode = rejectedProviderResponse(response);
	if (providerCode) {
		throw new WeixinApiError(
			providerCode === "-14" ? "stale-token" : "updates-rejected",
			providerCode === "-14" ? "微信登录凭据已失效，请移除账号后重新扫码。" : "微信消息同步请求被拒绝。",
			{ providerCode },
		);
	}
	const msgs = Array.isArray(response.msgs) ? (response.msgs as WeixinUpdateMessage[]) : [];
	const buf = nonEmpty(response.get_updates_buf as string) ?? undefined;
	return { msgs, getUpdatesBuf: buf };
}

/** 发送文本（自动带 context_token 增强会话能力） */
export async function weixinSendText(opts: {
	baseUrl: string;
	token: string;
	toUserId: string;
	text: string;
	contextToken?: string;
	signal?: AbortSignal;
}): Promise<void> {
	const contextToken = opts.contextToken?.trim();
	const clientId = `pi-im-weixin-${randomUUID()}`;
	const response = await requestJson({
		method: "POST",
		baseUrl: opts.baseUrl,
		endpoint: "ilink/bot/sendmessage",
		token: opts.token,
		signal: opts.signal,
		body: {
			msg: {
				from_user_id: "",
				to_user_id: opts.toUserId,
				client_id: clientId,
				message_type: 2,
				message_state: 2,
				item_list: [{ type: 1, text_item: { text: opts.text } }],
				...(contextToken ? { context_token: contextToken } : {}),
			},
			base_info: weixinBaseInfo(),
		},
	});
	const providerCode = rejectedProviderResponse(response);
	if (providerCode) {
		throw new WeixinApiError("send-rejected", "微信服务拒绝了回复消息。", { providerCode });
	}
}

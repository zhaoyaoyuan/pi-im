/**
 * 企业微信智能机器人扫码注册：移植自 dsh-im 的 qr-auth 协议。
 * GET work.weixin.qq.com/ai/qc/generate → scode + auth_url → 用户扫码
 * → GET ai/qc/query_result 轮询 → botid + secret。
 */

const GENERATE_URL = "https://work.weixin.qq.com/ai/qc/generate";
const POLL_URL = "https://work.weixin.qq.com/ai/qc/query_result";
export const WECOM_QR_TTL_MS = 5 * 60_000;
export const WECOM_POLL_INTERVAL_MS = 3_000;

export interface WecomQrInfo {
	scode: string;
	verificationUrl: string;
	expiresAt: number;
	pollIntervalMs: number;
}

export type WecomPollResult =
	| { status: "WAITING" }
	| { status: "SUCCESS"; botId: string; secret: string }
	| { status: "EXPIRED" }
	| { status: "FAILED" };

function clean(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 只信任 work.weixin.qq.com 的扫码地址 */
export function safeVerificationUrl(raw: unknown): string | null {
	const value = clean(raw);
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname === "work.weixin.qq.com" && (!url.port || url.port === "443")
			? url.href
			: null;
	} catch {
		return null;
	}
}

async function requestJson(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const res = await fetch(url, {
		method: "GET",
		redirect: "error",
		signal: AbortSignal.any([signal ?? AbortSignal.timeout(10_000)]),
		headers: { accept: "application/json" },
	});
	if (!res.ok) throw new Error(`企业微信扫码服务 HTTP ${res.status}`);
	return (await res.json()) as Record<string, unknown>;
}

/** 申请二维码 */
export async function wecomQrStart(signal?: AbortSignal): Promise<WecomQrInfo> {
	const url = new URL(GENERATE_URL);
	url.searchParams.set("source", "pi-im");
	// plat: 1=macOS 2=Windows 3=Linux
	url.searchParams.set("plat", process.platform === "win32" ? "2" : process.platform === "linux" ? "3" : "1");
	const body = await requestJson(url.toString(), signal);
	const data = body.data as Record<string, unknown> | undefined;
	const scode = clean(data?.scode);
	const verificationUrl = safeVerificationUrl(data?.auth_url);
	if (!scode || !verificationUrl) throw new Error("企业微信扫码服务返回无效数据");
	return {
		scode,
		verificationUrl,
		expiresAt: Date.now() + WECOM_QR_TTL_MS,
		pollIntervalMs: WECOM_POLL_INTERVAL_MS,
	};
}

/** 轮询一次扫码状态 */
export async function wecomQrPoll(scode: string, signal?: AbortSignal): Promise<WecomPollResult> {
	const url = new URL(POLL_URL);
	url.searchParams.set("scode", scode);
	const body = await requestJson(url.toString(), signal);
	const data = body.data as Record<string, unknown> | undefined;
	const state = clean(data?.status)?.toLowerCase();
	if (state === "success") {
		const botInfo = data?.bot_info as Record<string, unknown> | undefined;
		const botId = clean(botInfo?.botid);
		const secret = clean(botInfo?.secret);
		if (!botId || !secret) throw new Error("企业微信扫码结果缺少机器人凭据");
		return { status: "SUCCESS", botId, secret };
	}
	if (state === "expired" || state === "timeout") return { status: "EXPIRED" };
	if (state === "fail" || state === "failed" || state === "error") return { status: "FAILED" };
	return { status: "WAITING" };
}

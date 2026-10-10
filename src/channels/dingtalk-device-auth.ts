/**
 * 钉钉扫码设备注册：移植自 dsh-im 的 device-auth 协议。
 * POST /app/registration/init → begin（device_code + verification_url_complete）→ poll。
 */

const BASE_URL = "https://oapi.dingtalk.com";
const SOURCE = "DING_DWS_CLAW";

export interface DingtalkQrInfo {
	deviceCode: string;
	verificationUrl: string;
	expiresAt: number;
	pollIntervalMs: number;
}

export type DingtalkPollResult =
	| { status: "WAITING" }
	| { status: "SUCCESS"; clientId: string; clientSecret: string }
	| { status: "FAIL"; failReason?: string }
	| { status: "EXPIRED" };

async function post(path: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const res = await fetch(`${BASE_URL}${path}`, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/json" },
		body: JSON.stringify(body),
		redirect: "error",
		signal,
	});
	if (!res.ok) throw new Error(`钉钉注册接口 HTTP ${res.status}`);
	const data = (await res.json()) as Record<string, unknown>;
	if (Number(data.errcode) !== 0) {
		throw new Error(`钉钉注册接口被拒绝: errcode=${data.errcode} ${String(data.errmsg ?? "")}`);
	}
	return data;
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** 申请二维码 */
export async function dingtalkQrStart(signal?: AbortSignal): Promise<DingtalkQrInfo> {
	const init = await post("/app/registration/init", { source: SOURCE }, signal);
	const nonce = str(init.nonce);
	if (!nonce) throw new Error("钉钉注册初始化未返回 nonce");

	const begun = await post("/app/registration/begin", { nonce }, signal);
	const deviceCode = str(begun.device_code);
	const verificationUrl = str(begun.verification_uri_complete);
	if (!deviceCode || !verificationUrl) throw new Error("钉钉注册未返回完整二维码信息");

	const expiresIn = Number(begun.expires_in) > 0 ? Number(begun.expires_in) : 7200;
	const interval = Number(begun.interval) > 0 ? Number(begun.interval) : 5;
	return {
		deviceCode,
		verificationUrl,
		expiresAt: Date.now() + expiresIn * 1000,
		pollIntervalMs: interval * 1000,
	};
}

/** 轮询一次注册状态 */
export async function dingtalkQrPoll(deviceCode: string, signal?: AbortSignal): Promise<DingtalkPollResult> {
	const res = await post("/app/registration/poll", { device_code: deviceCode }, signal);
	const raw = (str(res.status) ?? "UNKNOWN").toUpperCase();
	if (raw === "SUCCESS") {
		const clientId = str(res.client_id);
		const clientSecret = str(res.client_secret);
		if (!clientId || !clientSecret) throw new Error("钉钉注册结果缺少凭据");
		return { status: "SUCCESS", clientId, clientSecret };
	}
	if (raw === "FAIL") return { status: "FAIL", failReason: str(res.fail_reason) ?? undefined };
	if (raw === "EXPIRED") return { status: "EXPIRED" };
	return { status: "WAITING" };
}

/**
 * 飞书扫码注册：复刻 dsh-im 的设备注册状态机。
 * 流程：SDK 申请注册 → 返回二维码 URL + 有效期 → 用户扫码确认 → 长轮询拿到
 * client_id / client_secret → onCredentials 回调入库。
 */
import * as Lark from "@larksuiteoapi/node-sdk";

export type RegistrationState =
	| "starting"
	| "qr_ready"
	| "polling"
	| "slow_down"
	| "saving"
	| "succeeded"
	| "expired"
	| "cancelled"
	| "error";

export interface RegistrationSnapshot {
	state: RegistrationState;
	qrCodeUrl?: string;
	expiresIn?: number;
	error?: string;
}

export interface RegistrationEvents {
	onSnapshot: (snapshot: RegistrationSnapshot) => void;
	/** 拿到凭据（此时状态为 saving），入库完成后 resolve */
	onCredentials: (creds: { appId: string; appSecret: string; botName?: string }) => Promise<void>;
	signal?: AbortSignal;
}

export interface RegistrationResult {
	botName?: string;
}

/** 启动一次飞书扫码注册，Promise 在终态 resolve */
export async function registerFeishuApp(events: RegistrationEvents): Promise<RegistrationResult> {
	events.onSnapshot({ state: "starting" });
	const signal = events.signal ?? new AbortController().signal;

	try {
		const result = await (
			Lark as unknown as {
				registerApp: (opts: Record<string, unknown>) => Promise<{
					client_id: string;
					client_secret: string;
					user_info?: { name?: string; open_id?: string };
				}>;
			}
		).registerApp({
			signal,
			onQRCodeReady: (info: { url: string; expireIn?: number }) => {
				events.onSnapshot({ state: "qr_ready", qrCodeUrl: info.url, expiresIn: info.expireIn });
			},
			onStatusChange: (info: { status: string }) => {
				if (info.status === "polling") events.onSnapshot({ state: "polling" });
				if (info.status === "slow_down") events.onSnapshot({ state: "slow_down" });
			},
		});

		if (!result?.client_id || !result?.client_secret) {
			throw new Error("飞书注册未返回有效凭据");
		}
		events.onSnapshot({ state: "saving" });
		const botName = result.user_info?.name;
		await events.onCredentials({ appId: result.client_id, appSecret: result.client_secret, botName });
		events.onSnapshot({ state: "succeeded" });
		return { botName };
	} catch (err) {
		const e = err as Error & { code?: string };
		let state: RegistrationState = "error";
		if (e.code === "expired_token" || /expire/i.test(e.message)) state = "expired";
		if (e.code === "abort" || e.name === "AbortError") state = "cancelled";
		events.onSnapshot({ state, error: e.message });
		if (state === "cancelled") throw err;
		throw new Error(`飞书注册失败: ${e.message}`);
	}
}

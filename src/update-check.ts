/**
 * 插件自检更新：比对本机安装版本与 GitHub 最新 Release，
 * 有新版时通过 pi 通知（每日最多检查一次，每个版本最多通知一次）。
 *
 * 通知驱动：GitHub Releases（语义化版本）。`/im version` 可强制检查并
 * 显示本机 git HEAD 与远端 main 的差异（信息性展示，不触发通知）。
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { imHome } from "./store.js";

const execFileAsync = promisify(execFile);

export const REPO = "zhaoyaoyuan/pi-im";
export const UPGRADE_CMD = `pi update git:github.com/${REPO}`;
const API = `https://api.github.com/repos/${REPO}`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STATE_FILE = () => join(imHome(), "update-state.json");

interface UpdateState {
	lastCheckAt?: number;
	/** 已通知过的最新版本（同版本不重复打扰） */
	notifiedVersion?: string;
}

let stateCache: UpdateState | null = null;

async function loadState(): Promise<UpdateState> {
	if (stateCache) return stateCache;
	try {
		stateCache = JSON.parse(await readFile(STATE_FILE(), "utf8")) as UpdateState;
	} catch {
		stateCache = {};
	}
	return stateCache;
}

async function saveState(state: UpdateState): Promise<void> {
	stateCache = state;
	await mkdir(imHome(), { recursive: true });
	await writeFile(STATE_FILE(), JSON.stringify(state, null, 2), { mode: 0o600 }).catch(() => {});
}

/** 本机插件版本（安装目录的 package.json） */
export async function localVersion(): Promise<string> {
	try {
		const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** 本机 git HEAD 短 sha（git 安装时可用，本地开发目录也是 git 仓库） */
export async function localGitSha(): Promise<string | null> {
	try {
		const dir = new URL("..", import.meta.url).pathname;
		const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { timeout: 5_000 });
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/** 远端 main 最新提交短 sha */
export async function remoteGitSha(): Promise<string | null> {
	try {
		const res = await fetch(`${API}/commits/main`, {
			headers: { accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { sha?: string };
		return data.sha?.slice(0, 7) ?? null;
	} catch {
		return null;
	}
}

/** 最新 Release（无 Release 时返回 null） */
export async function latestRelease(): Promise<{ tag: string; version: string; url: string; publishedAt?: string } | null> {
	try {
		const res = await fetch(`${API}/releases/latest`, {
			headers: { accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as { tag_name?: string; html_url?: string; published_at?: string };
		const tag = data.tag_name;
		if (!tag) return null;
		return {
			tag,
			version: tag.replace(/^v/, ""),
			url: data.html_url ?? `https://github.com/${REPO}/releases`,
			publishedAt: data.published_at,
		};
	} catch {
		return null;
	}
}

/** 简单 semver 比较：a > b 返回 true */
export function isNewerVersion(a: string, b: string): boolean {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x > y) return true;
		if (x < y) return false;
	}
	return false;
}

export interface UpdateCheckResult {
	checked: boolean;
	skipped?: boolean;
	current: string;
	latest?: string;
	updateAvailable: boolean;
	releaseUrl?: string;
	/** 强制检查时附带的 git 信息（信息性，不驱动通知） */
	localSha?: string | null;
	remoteSha?: string | null;
	error?: string;
}

/**
 * 检查更新。
 * @param force 跳过 24h 节流（/im version 使用）
 */
export async function checkForUpdate(force = false): Promise<UpdateCheckResult> {
	const current = await localVersion();
	const state = await loadState();
	if (!force && state.lastCheckAt && Date.now() - state.lastCheckAt < CHECK_INTERVAL_MS) {
		return { checked: false, skipped: true, current, updateAvailable: false };
	}
	state.lastCheckAt = Date.now();
	await saveState(state);

	try {
		const release = await latestRelease();
		if (!release) {
			return { checked: true, current, updateAvailable: false };
		}
		const updateAvailable = isNewerVersion(release.version, current);
		return {
			checked: true,
			current,
			latest: release.version,
			updateAvailable,
			releaseUrl: release.url,
			localSha: force ? await localGitSha() : undefined,
			remoteSha: force ? await remoteGitSha() : undefined,
		};
	} catch (err) {
		return { checked: false, current, updateAvailable: false, error: (err as Error).message };
	}
}

/**
 * 有新版且该版本未通知过 → 返回通知文案并记录（每个版本只通知一次）。
 * 返回 null 表示不通知（无更新 / 已通知过 / 检查失败）。
 */
export async function updateNotification(result: UpdateCheckResult): Promise<string | null> {
	if (!result.updateAvailable || !result.latest) return null;
	const state = await loadState();
	if (state.notifiedVersion === result.latest) return null;
	state.notifiedVersion = result.latest;
	await saveState(state);
	return [
		`📦 pi-im 有新版本：${result.latest}（当前 ${result.current}）`,
		`运行 ${UPGRADE_CMD} 升级，然后重启 pi。`,
		result.releaseUrl,
	].join("\n");
}

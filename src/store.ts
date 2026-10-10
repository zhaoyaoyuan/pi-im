import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BotConfig } from "./types.js";

/** pi-im 数据目录：~/.pi/im */
export function imHome(): string {
	return process.env.PI_IM_HOME ?? join(homedir(), ".pi", "im");
}

const CONFIG_FILE = () => join(imHome(), "config.json");

interface PersistShape {
	bots: BotConfig[];
	/** 上次会话绑定的路由（渠道:botId:chatId），重启后可恢复主动投递目标 */
	lastRoute?: string | null;
}

let cache: PersistShape | null = null;

async function ensureDir(): Promise<void> {
	await mkdir(imHome(), { recursive: true });
}

export async function loadPersist(): Promise<PersistShape> {
	if (cache) return cache;
	try {
		const raw = await readFile(CONFIG_FILE(), "utf8");
		cache = JSON.parse(raw) as PersistShape;
	} catch {
		cache = { bots: [] };
	}
	if (!Array.isArray(cache.bots)) cache.bots = [];
	return cache;
}

async function persist(data: PersistShape): Promise<void> {
	cache = data;
	await ensureDir();
	const file = CONFIG_FILE();
	await writeFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
	await chmod(file, 0o600).catch(() => {});
}

export async function listBots(): Promise<BotConfig[]> {
	return (await loadPersist()).bots;
}

export async function saveBot(bot: BotConfig): Promise<void> {
	const data = await loadPersist();
	const idx = data.bots.findIndex((b) => b.channel === bot.channel && b.botId === bot.botId);
	if (idx >= 0) data.bots[idx] = bot;
	else data.bots.push(bot);
	await persist(data);
}

export async function removeBot(channel: string, botId: string): Promise<boolean> {
	const data = await loadPersist();
	const before = data.bots.length;
	data.bots = data.bots.filter((b) => !(b.channel === channel && b.botId === botId));
	if (data.bots.length !== before) {
		await persist(data);
		return true;
	}
	return false;
}

export async function setLastRoute(route: string | null): Promise<void> {
	const data = await loadPersist();
	data.lastRoute = route;
	// 高频写盘没必要，只在变化时写
	if (cache) await persist(data);
}

export async function getLastRoute(): Promise<string | null> {
	return (await loadPersist()).lastRoute ?? null;
}

export function routeKey(route: { channel: string; botId: string; chatId: string }): string {
	return `${route.channel}:${route.botId}:${route.chatId}`;
}

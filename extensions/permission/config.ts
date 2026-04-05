/**
 * Configuration Loading
 * 
 * Handles loading and merging global/local permission configs.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { PermissionConfig, LoadedConfigs } from "./types.js";

export const GLOBAL_CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "permission-settings.json");
export const LOCAL_CONFIG_PATH = ".pi/permission-settings.json";
export const DEFAULT_AUTO_DENY = false;

export const DEFAULT_CONFIG: PermissionConfig = {
	allow: {
		read: ["**"],
		write: ["**"],
		edit: ["**"],
	},
	deny: {
		read: [],
		write: [],
		edit: [],
	},
	autoDeny: DEFAULT_AUTO_DENY,
};

/**
 * Load a config file if it exists
 */
export async function loadConfig(configPath: string): Promise<PermissionConfig | null> {
	try {
		const content = await fs.readFile(configPath, "utf-8");
		const parsed = JSON.parse(content);

		// Validate and normalize
		return {
			allow: {
				read: parsed.allow?.read ?? [],
				write: parsed.allow?.write ?? [],
				edit: parsed.allow?.edit ?? [],
			},
			deny: {
				read: parsed.deny?.read ?? [],
				write: parsed.deny?.write ?? [],
				edit: parsed.deny?.edit ?? [],
			},
			autoDeny: parsed.autoDeny ?? DEFAULT_AUTO_DENY,
		};
	} catch {
		return null;
	}
}

/**
 * Load configs (global + local)
 */
export async function loadConfigs(cwd: string): Promise<LoadedConfigs> {
	const [global, local] = await Promise.all([
		loadConfig(GLOBAL_CONFIG_PATH),
		loadConfig(path.join(cwd, LOCAL_CONFIG_PATH)),
	]);

	return { global, local };
}

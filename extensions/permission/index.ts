/**
 * Pi-coding-agent Permission System Extension
 * 
 * Extension that controls file and tool access based on configurable rules.
 * Similar to permission systems in Cloud Code but with full control over
 * what files and tools are allowed or restricted.
 * 
 * Features:
 * - Allow/Deny rules for read, write, edit operations
 * - Wildcard support (*, **)
 * - Global and local configuration files
 * - Priority system (local > global, more specific > less specific)
 * - User confirmation for restricted operations
 * - Session-based permissions
 * - request_permission custom tool
 * 
 * Configuration:
 * - Global: ~/.pi/agent/permission-settings.json
 * - Local: .pi/permission-settings.json
 * 
 * Commands:
 * - /permissions - Show current permissions status
 * - /permissions-reload - Reload permissions configuration
 * - /permissions-clear-session - Clear session permissions
 */

import { ExtensionAPI, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import type { PermissionCategory, PermissionConfig, SessionPermissions, CheckResult } from "./types.js";
import { isPathProtected } from "./types.js";
import { loadConfigs } from "./config.js";
import { matchGlob, getMatchingPatterns, compareSpecificity, calcSpecificity, compareSpec, extractPathsFromBash, extractPathsFromGrep, getFilePathFromInput, getCategory } from "./path-matching.js";

// ============================================================================
// Session Management
// ============================================================================

function createSession(): SessionPermissions {
	return {
		allowedPaths: new Set<string>(),
		allowedWildcards: new Set<string>(),
	};
}

function addSessionPermission(session: SessionPermissions, filePath: string): void {
	if (filePath.includes("*")) {
		session.allowedWildcards.add(filePath);
	} else {
		session.allowedPaths.add(filePath);
	}
}

function checkSessionPermission(filePath: string, session: SessionPermissions): boolean {
	// Check exact paths
	if (session.allowedPaths.has(filePath)) {
		return true;
	}

	// Check wildcards
	for (const pattern of session.allowedWildcards) {
		if (matchGlob(filePath, pattern)) {
			return true;
		}
	}

	return false;
}

// ============================================================================
// Permission Checking
// ============================================================================

/**
 * Check if access to a path is allowed based on permission rules.
 * 
 * Logic (in order of priority):
 * 1. Session permissions (explicitly granted by user) - always allowed
 * 2. Path is inside current project (cwd) - allowed by default
 * 3. Path matches an allow rule - allowed
 * 4. Path matches a deny rule - denied
 * 5. Otherwise - denied
 * 
 * When both allow and deny rules match the path, specificity determines winner:
 * - More specific pattern (smaller file set) wins
 * - At equal specificity, deny wins over allow
 * 
 * @param filePath - Absolute path to check
 * @param category - Permission category (read/write/edit)
 * @param currentCwd - Current working directory (project root)
 * @param globalConfig - Global permission config (~/.pi/agent/)
 * @param localConfig - Local permission config (.pi/)
 * @param session - Session permissions (user-granted)
 */
function checkPath(
	filePath: string,
	category: PermissionCategory,
	currentCwd: string,
	globalConfig: PermissionConfig | null,
	localConfig: PermissionConfig | null,
	session: SessionPermissions
): CheckResult {
	// First check session permissions
	if (checkSessionPermission(filePath, session)) {
		return { allowed: true, isSessionPermission: true };
	}

	// Normalize paths for comparison
	const normalizedPath = filePath.replace(/\\/g, "/");
	const normalizedCwd = currentCwd.replace(/\\/g, "/");

	// Check if path is inside the current project (cwd)
	const isInProject = normalizedPath.startsWith(normalizedCwd + "/") || normalizedPath === normalizedCwd;

	// Get all matching rules from configs
	let allAllowRules: string[] = [];
	let allDenyRules: string[] = [];

	// Merge rules from local and global configs
	if (localConfig) {
		allAllowRules = [...allAllowRules, ...localConfig.allow[category]];
		allDenyRules = [...allDenyRules, ...localConfig.deny[category]];
	}
	if (globalConfig) {
		allAllowRules = [...allAllowRules, ...globalConfig.allow[category]];
		allDenyRules = [...allDenyRules, ...globalConfig.deny[category]];
	}

	const matchingDeny = getMatchingPatterns(normalizedPath, allDenyRules);
	const matchingAllow = getMatchingPatterns(normalizedPath, allAllowRules);

	// No matching rules at all
	if (matchingDeny.length === 0 && matchingAllow.length === 0) {
		if (isInProject) {
			return { allowed: true, isInProject: true };
		}
		return { allowed: false, rule: "(no matching rules, path not in project)", ruleType: "deny" };
	}

	// Sort both by specificity (most specific first)
	matchingDeny.sort(compareSpecificity);
	matchingAllow.sort(compareSpecificity);

	const mostSpecificDeny = matchingDeny[0];
	const mostSpecificAllow = matchingAllow[0];

	// If only deny rules match - deny
	if (!mostSpecificAllow) {
		return { allowed: false, rule: mostSpecificDeny, ruleType: "deny" };
	}

	// If only allow rules match - allow
	if (!mostSpecificDeny) {
		return { allowed: true, rule: mostSpecificAllow, ruleType: "allow" };
	}

	// Both match - compare specificity
	const denySpec = calcSpecificity(mostSpecificDeny);
	const allowSpec = calcSpecificity(mostSpecificAllow);
	const cmp = compareSpec(allowSpec, denySpec);

	// compareSpec returns positive if a > b (allow more specific)
	if (cmp > 0) {
		// Allow is more specific - wins
		return { allowed: true, rule: mostSpecificAllow, ruleType: "allow" };
	}
	// If cmp <= 0, deny wins (either more specific, or equal specificity where deny has priority)
	return { allowed: false, rule: mostSpecificDeny, ruleType: "deny" };
}

// ============================================================================
// Main Extension
// ============================================================================

export default async function permissionsExtension(pi: ExtensionAPI): Promise<void> {
	console.log("[Permissions] Extension loaded");

	// Session state
	const session = createSession();
	let currentCwd = process.cwd();

	// Register request_permission tool
	pi.registerTool({
		name: "request_permission",
		label: "Request Permission",
		description: "Request permission to access a file or directory (including all files in a directory). Use this tool BEFORE attempting restricted operations.",
		parameters: Type.Object({
			path: Type.String({ description: "Path to file or directory" }),
			action: Type.Union([
				Type.Literal("read"),
				Type.Literal("write"),
				Type.Literal("edit"),
			], { description: "Type of access" }),
			reason: Type.Optional(Type.String({ description: "Reason for request" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { path: filePath, action, reason } = params as {
				path: string;
				action: "read" | "write" | "edit";
				reason?: string;
			};

			// Resolve path
			const resolvedPath = path.isAbsolute(filePath)
				? filePath
				: path.join(currentCwd, filePath);

			// Check if already allowed
			if (checkSessionPermission(resolvedPath, session)) {
				return {
					content: [{ type: "text" as const, text: `Permission already granted for ${resolvedPath}` }],
					details: {},
				};
			}

			const message = reason
				? `Request permission for ${action} on ${resolvedPath}\nReason: ${reason}`
				: `Request permission for ${action} on ${resolvedPath}`;

			// Ask for confirmation
			const confirmed = await ctx.ui.confirm(
				"Permission Request",
				message
			);

			if (confirmed) {
				addSessionPermission(session, resolvedPath);
				return {
					content: [{ type: "text" as const, text: `Permission granted for ${resolvedPath} (${action})` }],
					details: {},
				};
			}

			return {
				content: [{ type: "text" as const, text: `Permission denied for ${resolvedPath}` }],
				details: {},
			};
		},
	});

	// Tool call interceptor
	pi.on("tool_call", async (event, ctx): Promise<{ block: true; reason: string } | undefined> => {
		const { toolName, input } = event;
		currentCwd = ctx.cwd;

		const category = getCategory(toolName);
		if (!category) {
			return undefined;
		}

		let pathsToCheck: string[] = [];

		// === READ tool ===
		if (isToolCallEventType("read", event)) {
			const filePath = getFilePathFromInput(input);
			if (!filePath) {
				return undefined;
			}
			const resolvedPath = path.isAbsolute(filePath)
				? filePath
				: path.join(currentCwd, filePath);
			pathsToCheck = [resolvedPath];
		}

		// === WRITE tool ===
		if (isToolCallEventType("write", event)) {
			const filePath = getFilePathFromInput(input);
			if (!filePath) {
				return undefined;
			}
			const resolvedPath = path.isAbsolute(filePath)
				? filePath
				: path.join(currentCwd, filePath);
			pathsToCheck = [resolvedPath];
		}

		// === EDIT tool ===
		if (isToolCallEventType("edit", event)) {
			const filePath = getFilePathFromInput(input);
			if (!filePath) {
				return undefined;
			}
			const resolvedPath = path.isAbsolute(filePath)
				? filePath
				: path.join(currentCwd, filePath);
			pathsToCheck = [resolvedPath];
		}

		// === BASH tool ===
		if (isToolCallEventType("bash", event)) {
			if (!("command" in input) || typeof input.command !== "string") {
				return undefined;
			}
			pathsToCheck = extractPathsFromBash(input.command);
		}

		// === GREP tool ===
		if (isToolCallEventType("grep", event)) {
			pathsToCheck = extractPathsFromGrep(input);
		}

		// Check all paths
		if (pathsToCheck.length === 0) {
			return undefined;
		}

		// Check for protected paths (edit/write on permission config files is not allowed)
		if (category === "edit" || category === "write") {
			for (const filePath of pathsToCheck) {
				if (isPathProtected(filePath)) {
					return {
						block: true,
						reason: `Access denied: ${filePath} is protected and cannot be edited. This prevents privilege escalation.`,
					};
				}
			}
		}

		const configs = await loadConfigs(currentCwd);
		// Use null instead of DEFAULT_CONFIG - if no config exists, only project files are allowed
		const globalConfig = configs.global;
		const localConfig = configs.local;
		const autoDeny = localConfig?.autoDeny ?? globalConfig?.autoDeny ?? false;

		for (const filePath of pathsToCheck) {
			const result = checkPath(filePath, category, currentCwd, globalConfig, localConfig, session);

			if (!result.allowed) {
				// Check if we should auto-deny
				if (autoDeny) {
					return {
						block: true,
						reason: `Path denied by permission rules: ${filePath} (rule: ${result.rule})`,
					};
				}

				// Ask for confirmation
				const confirmed = await ctx.ui.confirm(
					"Permission Denied",
					`Operation on ${filePath} is not allowed by permission rules.\n\nRule: ${result.rule}\nCategory: ${category}\n\nDo you want to allow this operation for the current session?`
				);

				if (confirmed) {
					addSessionPermission(session, filePath);
					console.log(`[Permissions] Session permission granted: ${filePath}`);
				} else {
					return {
						block: true,
						reason: `Access denied: ${filePath}`,
					};
				}
			}
		}

		console.log(`[Permissions] ${toolName} allowed for ${pathsToCheck.join(", ")}`);
		return undefined;
	});

	// Register commands
	pi.registerCommand("permissions", {
		description: "Show current permissions status",
		handler: async (_args: string, ctx) => {
			const configs = await loadConfigs(ctx.cwd);

			let status = `Global config: ${configs.global ? "loaded" : "not found"}\n`;
			status += `Local config: ${configs.local ? "loaded" : "not found"}\n`;
			status += `Session allowed paths: ${session.allowedPaths.size}\n`;
			status += `Session allowed wildcards: ${session.allowedWildcards.size}`;

			ctx.ui.notify(status, "info");
		},
	});

	pi.registerCommand("permissions-reload", {
		description: "Reload permissions configuration",
		handler: async (_args: string, ctx) => {
			const configs = await loadConfigs(ctx.cwd);
			ctx.ui.notify(
				`Configs loaded: global=${!!configs.global}, local=${!!configs.local}`,
				"info"
			);
		},
	});

	pi.registerCommand("permissions-clear-session", {
		description: "Clear session permissions",
		handler: async (_args: string, ctx) => {
			session.allowedPaths.clear();
			session.allowedWildcards.clear();
			ctx.ui.notify("Session permissions cleared", "info");
		},
	});

	console.log("[Permissions] Extension initialized");
}

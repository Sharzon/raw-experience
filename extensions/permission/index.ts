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
import * as fs from "node:fs";
import * as os from "node:os";
import type { PermissionCategory, PermissionConfig, SessionPermissions, CheckResult } from "./types.js";
import { isPathProtected } from "./types.js";
import { loadConfigs } from "./config.js";
import { matchGlob, getMatchingPatterns, compareSpecificity, calcSpecificity, compareSpec, extractPathsFromBash, extractPathsFromGrep, getFilePathFromInput, getCategory } from "./path-matching.js";

// ============================================================================
// Dynamic Permission Events Types
// ============================================================================

/** Event payload for raw-experience/permission:allow */
export interface PermissionAllowEvent {
	paths: string | string[];
	actions: ("read" | "write" | "edit")[];
}

/** Event payload for raw-experience/permission:deny */
export interface PermissionDenyEvent {
	paths: string | string[];
	actions: ("read" | "write" | "edit")[];
}

// ============================================================================
// Pi Package Path Discovery
// ============================================================================

/**
 * Find the pi-coding-agent package directory.
 * Uses process.execPath (node binary location) as the base to find node_modules.
 * This works regardless of the current working directory.
 */
function findPiPackageDir(): string | null {
	// Get node binary path and go up to find lib/node_modules
	const nodeDir = path.dirname(process.execPath); // e.g., /Users/.../node/v24.11.1/bin
	const libDir = path.join(nodeDir, "..", "lib"); // e.g., /Users/.../node/v24.11.1/lib
	const nodeModulesPath = path.join(libDir, "node_modules", "@mariozechner", "pi-coding-agent");
	
	if (fs.existsSync(nodeModulesPath)) {
		const packageJsonPath = path.join(nodeModulesPath, "package.json");
		if (fs.existsSync(packageJsonPath)) {
			return nodeModulesPath;
		}
	}
	return null;
}

/** Get the pi package directory, or null if not found */
export function getPiPackageDir(): string | null {
	return findPiPackageDir();
}

// Session management

function createSession(): SessionPermissions {
	return {
		allowedPaths: new Map<string, Set<PermissionCategory>>(),
		allowedWildcards: new Map<string, Set<PermissionCategory>>(),
		dynamicAllowRules: [],
		dynamicDenyRules: [],
	};
}

function addSessionPermission(session: SessionPermissions, filePath: string, category: PermissionCategory): void {
	const normalizedPath = filePath.replace(/\\/g, "/");
	
	if (normalizedPath.includes("*")) {
		let existing = session.allowedWildcards.get(normalizedPath);
		if (!existing) {
			existing = new Set<PermissionCategory>();
			session.allowedWildcards.set(normalizedPath, existing);
		}
		existing.add(category);
	} else {
		let existing = session.allowedPaths.get(normalizedPath);
		if (!existing) {
			existing = new Set<PermissionCategory>();
			session.allowedPaths.set(normalizedPath, existing);
		}
		existing.add(category);
	}
}

function checkSessionPermission(filePath: string, category: PermissionCategory, session: SessionPermissions): boolean {
	const normalizedPath = filePath.replace(/\\/g, "/");
	
	// Check exact paths
	const exactMatch = session.allowedPaths.get(normalizedPath);
	if (exactMatch && exactMatch.has(category)) {
		return true;
	}

	// Check wildcards
	for (const [pattern, allowedCategories] of session.allowedWildcards) {
		if (!allowedCategories.has(category)) {
			continue; // Skip if this category is not allowed for this pattern
		}
		if (matchGlob(normalizedPath, pattern)) {
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
 * 1. Dynamic rules (events) - highest priority
 * 2. Session permissions (explicitly granted by user) - always allowed
 * 3. Path is inside current project (cwd) - allowed by default
 * 4. Path matches an allow rule - allowed
 * 5. Path matches a deny rule - denied
 * 6. Otherwise - denied
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
	const normalizedPath = filePath.replace(/\\/g, "/");

	// 1. Check dynamic rules first (highest priority)
	const dynamicDenyMatch = session.dynamicDenyRules.find(rule =>
		rule.actions.includes(category) &&
		rule.paths.some(p => matchGlob(normalizedPath, p))
	);
	if (dynamicDenyMatch) {
		return { allowed: false, rule: "(dynamic deny rule)", ruleType: "deny" };
	}

	const dynamicAllowMatch = session.dynamicAllowRules.find(rule =>
		rule.actions.includes(category) &&
		rule.paths.some(p => matchGlob(normalizedPath, p))
	);
	if (dynamicAllowMatch) {
		return { allowed: true, rule: "(dynamic allow rule)", ruleType: "allow" };
	}

	// 2. Check session permissions (explicitly granted by user)
	if (checkSessionPermission(filePath, category, session)) {
		return { allowed: true, isSessionPermission: true };
	}

	// Always allow READ access to pi-coding-agent package (the package itself)
	// This ensures the permission system can always read its own package files
	const piPackageDir = findPiPackageDir();
	if (piPackageDir) {
		const normalizedPiDir = piPackageDir.replace(/\\/g, "/");
		if (normalizedPath.startsWith(normalizedPiDir + "/")) {
			// Only allow read, not write/edit to pi package
			if (category === "read") {
				return { allowed: true, rule: "(pi package read allowed)", ruleType: "allow" };
			}
		}
	}

	// Normalize paths for comparison
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

	// Check if debug mode is enabled
	const isDebug = process.env.DEBUG === "true" || process.env.PI_DEBUG === "true";

	// ============================================================================
	// Local Packages Discovery
	// ============================================================================

	/**
	 * Scan the local packages directory and add all cached packages
	 * to the session's dynamic allow rules.
	 * This allows reading package code without permission prompts.
	 */
	function scanLocalPackages(): void {
		const packagesDir = path.join(os.homedir(), ".pi", "packages");
		
		if (!fs.existsSync(packagesDir)) {
			return;
		}

		// Scan JS/TS packages
		const jsDir = path.join(packagesDir, "JS");
		if (fs.existsSync(jsDir)) {
			try {
				const jsPackages = fs.readdirSync(jsDir);
				for (const pkg of jsPackages) {
					const pkgPath = path.join(jsDir, pkg);
					const stat = fs.statSync(pkgPath);
					if (stat.isDirectory()) {
						// Check if it's a scoped package (@scope/name)
						if (pkg.startsWith("@")) {
							// For scoped packages, scan inside
							try {
								const scopedPackages = fs.readdirSync(pkgPath);
								for (const scopedPkg of scopedPackages) {
									const scopedPath = path.join(pkgPath, scopedPkg);
									const scopedStat = fs.statSync(scopedPath);
									if (scopedStat.isDirectory()) {
										session.dynamicAllowRules.push({
											paths: [scopedPath, `${scopedPath}/**`],
											actions: ["read"],
										});
										if (isDebug) {
											console.log(`[Permissions] Auto-allowed cached package: ${scopedPath}`);
										}
									}
								}
							} catch (e) {
								// Ignore errors reading scoped packages
							}
						} else {
							session.dynamicAllowRules.push({
								paths: [pkgPath, `${pkgPath}/**`],
								actions: ["read"],
							});
							if (isDebug) {
								console.log(`[Permissions] Auto-allowed cached package: ${pkgPath}`);
							}
						}
					}
				}
			} catch (e) {
				// Ignore errors reading JS packages dir
			}
		}

		// Scan Python packages
		const pythonDir = path.join(packagesDir, "Python");
		if (fs.existsSync(pythonDir)) {
			try {
				const pythonPackages = fs.readdirSync(pythonDir);
				for (const pkg of pythonPackages) {
					const pkgPath = path.join(pythonDir, pkg);
					const stat = fs.statSync(pkgPath);
					if (stat.isDirectory()) {
						session.dynamicAllowRules.push({
							paths: [pkgPath, `${pkgPath}/**`],
							actions: ["read"],
						});
						if (isDebug) {
							console.log(`[Permissions] Auto-allowed cached Python package: ${pkgPath}`);
						}
					}
				}
			} catch (e) {
				// Ignore errors reading Python packages dir
			}
		}
	}

	// Scan for locally cached packages on startup
	scanLocalPackages();

	// Subscribe to dynamic permission events from other extensions
	pi.events.on("raw-experience/permission:allow", (event) => {
		const permissionEvent = event as PermissionAllowEvent;
		const paths = Array.isArray(permissionEvent.paths) ? permissionEvent.paths : [permissionEvent.paths];
		session.dynamicAllowRules.push({
			paths,
			actions: permissionEvent.actions,
		});
		if (isDebug) {
			console.log(`[Permissions] Dynamic allow rule added: ${paths.join(", ")} for ${permissionEvent.actions.join(", ")}`);
		}
	});

	pi.events.on("raw-experience/permission:deny", (event) => {
		const permissionEvent = event as PermissionDenyEvent;
		const paths = Array.isArray(permissionEvent.paths) ? permissionEvent.paths : [permissionEvent.paths];
		session.dynamicDenyRules.push({
			paths,
			actions: permissionEvent.actions,
		});
		if (isDebug) {
			console.log(`[Permissions] Dynamic deny rule added: ${paths.join(", ")} for ${permissionEvent.actions.join(", ")}`);
		}
	});

	// Clean up dynamic rules on session shutdown
	pi.on("session_shutdown", async () => {
		const allowCount = session.dynamicAllowRules.length;
		const denyCount = session.dynamicDenyRules.length;
		session.dynamicAllowRules = [];
		session.dynamicDenyRules = [];
		if (isDebug && (allowCount > 0 || denyCount > 0)) {
			console.log(`[Permissions] Dynamic rules cleared: ${allowCount} allow, ${denyCount} deny`);
		}
	});

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
			if (checkSessionPermission(resolvedPath, action, session)) {
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
				addSessionPermission(session, resolvedPath, action);
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
					addSessionPermission(session, filePath, category);
					console.log(`[Permissions] Session permission granted: ${filePath} (${category})`);
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
			status += `Session allowed wildcards: ${session.allowedWildcards.size}\n`;
			status += `Dynamic allow rules: ${session.dynamicAllowRules.length}\n`;
			status += `Dynamic deny rules: ${session.dynamicDenyRules.length}`;

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

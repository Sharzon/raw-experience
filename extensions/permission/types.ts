/**
 * Permission System Types
 */

export type PermissionCategory = "read" | "write" | "edit";

// Paths that cannot be edited by the agent (to prevent privilege escalation)
export const PROTECTED_PATHS = [
	// Global config
	/^\.pi\/agent\/permission-settings\.json$/,
	// Local config
	/^\.pi\/permission-settings\.json$/,
];

export function isPathProtected(filePath: string): boolean {
	return PROTECTED_PATHS.some(pattern => pattern.test(filePath));
}

export interface PermissionConfig {
	allow: {
		read: string[];
		write: string[];
		edit: string[];
	};
	deny: {
		read: string[];
		write: string[];
		edit: string[];
	};
	autoDeny: boolean;
}

export interface SessionPermissions {
	allowedPaths: Map<string, Set<PermissionCategory>>;
	allowedWildcards: Map<string, Set<PermissionCategory>>;
}

export interface CheckResult {
	allowed: boolean;
	rule?: string;
	ruleType?: "allow" | "deny";
	isSessionPermission?: boolean;
	isInProject?: boolean;  // True if path is within current working directory (default-allowed)
}

export interface LoadedConfigs {
	global: PermissionConfig | null;
	local: PermissionConfig | null;
}

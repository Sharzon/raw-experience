/**
 * Path Matching Utilities
 * 
 * Handles glob/wildcard pattern matching for permission rules.
 */

import * as path from "node:path";
import * as os from "node:os";

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
	let regexStr = pattern
		// Escape special regex characters except * and **
		.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
		// ** matches any path including subdirectories
		.replace(/\*\*/g, "<<DOUBLE_STAR>>")
		// * matches any characters except path separator
		.replace(/\*/g, "[^/]*")
		// Restore **
		.replace(/<<DOUBLE_STAR>>/g, ".*")
		// Anchor to path boundaries
		.replace(/^\.\//, "")
		.replace(/\$$/, "");

	// Check if pattern should match from start or anywhere
	if (!regexStr.startsWith("^") && !regexStr.startsWith(".*")) {
		regexStr = "^" + regexStr;
	}
	if (!regexStr.endsWith("$") && !regexStr.endsWith(".*")) {
		regexStr = regexStr + "$";
	}

	return new RegExp(regexStr);
}

/**
 * Check if a path matches a glob pattern
 */
export function matchGlob(filePath: string, pattern: string): boolean {
	// Normalize path separators
	const normalizedPath = filePath.replace(/\\/g, "/");
	const normalizedPattern = pattern.replace(/\\/g, "/");

	// Handle exact match (without wildcards)
	if (!normalizedPattern.includes("*")) {
		return normalizedPath === normalizedPattern ||
			normalizedPath.startsWith(normalizedPattern + "/") ||
			normalizedPath.endsWith("/" + normalizedPattern);
	}

	const regex = globToRegex(normalizedPattern);
	return regex.test(normalizedPath);
}

/**
 * Get all matching glob patterns for a path
 */
export function getMatchingPatterns(filePath: string, patterns: string[]): string[] {
	return patterns.filter(pattern => matchGlob(filePath, pattern));
}

/**
 * Specificity Calculation
 * 
 * Specificity determines which pattern is "more specific" for a given path.
 * More specific = smaller set of matched files = higher priority.
 * 
 * Specificity is a 5-component tuple:
 * [literal_segments, literal_chars_in_wildcarded, question_count, star_segments, double_star_segments]
 * 
 * Comparison order (lexicographic):
 * 1. literal_segments: more literal path segments = more specific
 * 2. literal_chars_in_wildcarded: more literal chars inside wildcards (e.g., "*.ts" has 3) = more specific
 * 3. question_count: more ? symbols = stricter length constraint = more specific
 * 4. star_segments: fewer * segments = less broad = more specific
 * 5. double_star_segments: fewer ** = less broad = more specific
 * 
 * Examples:
 * - "src/app.ts"     → (2, 0, 0, 0, 0)  - most specific, exact file
 * - "src/?.ts"       → (1, 2, 1, 1, 0)  - ? fixes length, stricter than *
 * - "src/*.ts"       → (1, 2, 0, 1, 0)  - has .ts extension
 * - "src/*"          → (1, 0, 0, 1, 0)
 * - "src/**"         → (1, 0, 0, 0, 1)
 * - "**"             → (0, 0, 0, 0, 1)  - least specific, matches everything
 */

type Specificity = [number, number, number, number, number];

/**
 * Calculate specificity tuple for a glob pattern.
 * @param pattern - Glob pattern (e.g., "src/**", "*.ts", "config.json")
 * @returns Specificity tuple
 */
export function calcSpecificity(pattern: string): Specificity {
	const normalizedPattern = pattern.replace(/^\//, '').replace(/\\/g, '/');
	const segments = normalizedPattern.split('/').filter(s => s);

	let literalSegments = 0;
	let literalCharsInWildcarded = 0; // Literals inside segments with * or ?
	let questionCount = 0;            // Each ? fixes exactly one character
	let starSegments = 0;             // Segments containing * (but not **)
	let doubleStarSegments = 0;       // Segments that are exactly **

	for (const seg of segments) {
		if (seg === '**') {
			doubleStarSegments++;
		} else if (seg.includes('*') || seg.includes('?')) {
			// This segment has wildcards - count literal chars within it
			// e.g., "*.ts" has 3 literal chars (".ts"), "foo*" has 3 ("foo")
			literalCharsInWildcarded += seg.replace(/[*?]/g, '').length;
			questionCount += (seg.match(/\?/g) || []).length;
			starSegments++;
		} else {
			// Pure literal segment (no wildcards)
			literalSegments++;
		}
	}

	return [literalSegments, literalCharsInWildcarded, questionCount, starSegments, doubleStarSegments];
}

/**
 * Compare two specificity tuples.
 * Returns positive if a > b, negative if a < b, zero if equal.
 * Higher specificity = wins over lower.
 */
export function compareSpec(a: Specificity, b: Specificity): number {
	// 1. More literal segments = more specific
	if (a[0] !== b[0]) return a[0] - b[0];
	
	// 2. More literal chars inside wildcarded segments = more specific
	// e.g., "*.ts" (3) > "*" (0)
	if (a[1] !== b[1]) return a[1] - b[1];
	
	// 3. More ? symbols = stricter length constraint = more specific
	// e.g., "?.ts" (1) > "*.ts" (0)
	if (a[2] !== b[2]) return a[2] - b[2];
	
	// 4. Fewer * segments = less broad = more specific (reverse order!)
	if (a[3] !== b[3]) return b[3] - a[3];
	
	// 5. Fewer ** = less broad = more specific (reverse order!)
	return b[4] - a[4];
}

/**
 * Compare specificity of two patterns.
 * Returns positive if pattern1 is more specific than pattern2.
 * Used for sorting: most specific first.
 */
export function compareSpecificity(pattern1: string, pattern2: string): number {
	return compareSpec(calcSpecificity(pattern2), calcSpecificity(pattern1)); // Descending order
}

// ============================================================================
// Path Extraction from Tools
// ============================================================================

/**
 * Extract paths from bash command
 */
export function extractPathsFromBash(command: string): string[] {
	const paths: string[] = [];

	// Match paths starting with / or ./ or ~/
	const pathRegex = /(?:^|\s)(\/[^\s*?\"\'\r\n]+|~?\.\/[^\s*?\"\'\r\n]+)/g;
	let match;
	while ((match = pathRegex.exec(command)) !== null) {
		let p = match[1];
		// Expand ~ to home directory
		if (p.startsWith("~/")) {
			p = path.join(os.homedir(), p.slice(2));
		}
		paths.push(p);
	}

	// Try to extract variable paths (e.g., $VAR, ${VAR})
	const varRegex = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
	while ((match = varRegex.exec(command)) !== null) {
		const varName = match[1];
		const varValue = process.env[varName];
		if (varValue && !varValue.includes("*")) {
			paths.push(varValue);
		}
	}

	// Try simple variable expansion
	const simpleVarRegex = /\$([A-Za-z_][A-Za-z0-9_]*)/g;
	while ((match = simpleVarRegex.exec(command)) !== null) {
		const varName = match[1];
		const varValue = process.env[varName];
		if (varValue && !varValue.includes("*") && !paths.includes(varValue)) {
			paths.push(varValue);
		}
	}

	return [...new Set(paths)];
}

/**
 * Extract paths from grep input
 */
export function extractPathsFromGrep(input: Record<string, unknown>): string[] {
	const paths: string[] = [];

	// Check for path or paths parameter
	if (typeof input.path === "string") {
		paths.push(input.path);
	} else if (Array.isArray(input.paths)) {
		paths.push(...input.paths.filter((p): p is string => typeof p === "string"));
	}

	// Check for pathOrPaths (some API versions)
	if (typeof input.pathOrPaths === "string") {
		paths.push(input.pathOrPaths);
	} else if (Array.isArray(input.pathOrPaths)) {
		paths.push(...input.pathOrPaths.filter((p): p is string => typeof p === "string"));
	}

	return [...new Set(paths)];
}

/**
 * Get file path from tool input
 */
export function getFilePathFromInput(input: Record<string, unknown>): string | undefined {
	return (input.path as string) ?? (input.file_path as string) ?? (input.file as string);
}

/**
 * Determine tool category based on tool name
 */
export function getCategory(toolName: string): "read" | "write" | "edit" | null {
	const normalized = toolName.toLowerCase();

	if (normalized === "read" || normalized === "grep") {
		return "read";
	}
	if (normalized === "write") {
		return "write";
	}
	if (normalized === "edit") {
		return "edit";
	}

	return null;
}

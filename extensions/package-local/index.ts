/**
 * package-local Pi Extension
 * 
 * Extension for managing local package caches, allowing the agent to read
 * code and documentation of dependencies without internet access.
 * 
 * Features:
 * - Show agent the location of local packages on startup
 * - Download packages on demand to local directory
 * - Support for JavaScript/TypeScript (npm) and Python (PyPI)
 * - Handle scoped packages (@scope/package)
 * 
 * Configuration:
 * - Default packages directory: ~/pi/packages
 * - Can be configured via settings
 */

import { ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { PermissionAllowEvent } from "../permission/index.js";

/**
 * Get the default packages directory (~/.pi/packages)
 */
function getPackagesDirectory(): string {
	// Allow override via environment variable
	const envDir = process.env.PI_PACKAGES_DIR;
	if (envDir) {
		return envDir;
	}
	
	// Default to ~/.pi/packages
	const homeDir = os.homedir();
	return path.join(homeDir, ".pi", "packages");
}

/**
 * Ensure the packages directory structure exists
 */
async function ensurePackagesDirectory(packagesDir: string): Promise<void> {
	const jsDir = path.join(packagesDir, "JS");
	const pythonDir = path.join(packagesDir, "Python");

	await fs.promises.mkdir(jsDir, { recursive: true });
	await fs.promises.mkdir(pythonDir, { recursive: true });
}

/**
 * Get the target directory for a package based on language
 */
function getTargetDirectory(packagesDir: string, language: string): string {
	const normalizedLang = language.toLowerCase();
	
	if (normalizedLang === "javascript" || normalizedLang === "typescript") {
		return path.join(packagesDir, "JS");
	} else if (normalizedLang === "python") {
		return path.join(packagesDir, "Python");
	}
	
	throw new Error(`Unsupported language: ${language}`);
}

/**
 * Get the final package path (handles scoped packages)
 */
function getPackagePath(targetDir: string, packageName: string): string {
	// Handle scoped packages (@scope/package -> @scope/package)
	// npm stores them as @scope%2Fpackage, but we want to keep original structure
	if (packageName.startsWith("@")) {
		// Convert @scope/package to @scope/package (folder structure)
		return path.join(targetDir, packageName.replace("/", path.sep));
	}
	
	return path.join(targetDir, packageName);
}

/**
 * Check if a package already exists locally
 */
async function packageExists(packagesDir: string, language: string, packageName: string): Promise<string | null> {
	const targetDir = getTargetDirectory(packagesDir, language);
	const packagePath = getPackagePath(targetDir, packageName);
	
	try {
		const stats = await fs.promises.stat(packagePath);
		if (stats.isDirectory()) {
			return packagePath;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Clone a GitHub repository to a target path
 */
async function cloneRepository(pi: ExtensionAPI, githubUrl: string, targetPath: string): Promise<void> {
	// Ensure parent directory exists
	const parentDir = path.dirname(targetPath);
	await fs.promises.mkdir(parentDir, { recursive: true });
	
	// Clone the repository
	const result = await pi.exec("git", ["clone", "--depth", "1", githubUrl, targetPath]);
	
	if (result.code !== 0) {
		throw new Error(`Git clone failed: ${result.stderr}`);
	}
}

export default async function packageLocalExtension(pi: ExtensionAPI): Promise<void> {
	console.log("[package-local] Extension loaded");

	const packagesDir = getPackagesDirectory();

	// Ensure packages directory exists on load
	await ensurePackagesDirectory(packagesDir);

	// Register the package_local tool
	pi.registerTool({
		name: "package_local",
		label: "Package Local",
		description: "Download a package to local cache for offline access. Supports JavaScript/TypeScript (npm) and Python (PyPI).",
		promptSnippet: "Download package source code for offline access",
		parameters: Type.Object({
			language: Type.Union([
				Type.Literal("javascript"),
				Type.Literal("typescript"),
				Type.Literal("python"),
			], { description: "Programming language: javascript, typescript, or python" }),
			package: Type.String({ description: "Package name (e.g., axios, lodash, @tanstack/react-query, requests)" }),
		}),
		async execute(
			toolCallId: string,
			params: { language: "javascript" | "typescript" | "python"; package: string },
			signal: AbortSignal | undefined,
			onUpdate: ((partialResult: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined,
			ctx: ExtensionContext
		): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
			const { language, package: packageName } = params;
			const trimmedPackage = packageName.trim();

			// Validate inputs
			if (!trimmedPackage) {
				return {
					content: [{ type: "text", text: JSON.stringify({ error: "Package name cannot be empty" }) }],
					details: {},
				};
			}

			const normalizedLanguage = language.toLowerCase();

			// Check if already exists
			const existingPath = await packageExists(packagesDir, normalizedLanguage, trimmedPackage);
			if (existingPath) {
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							path: existingPath,
							status: "already_exists",
							message: `Package '${trimmedPackage}' already exists at ${path.relative(packagesDir, existingPath)}`,
						}),
					}],
					details: {},
				};
			}

			try {
				onUpdate?.({
					content: [{ type: "text", text: `Looking up ${trimmedPackage}...` }],
					details: {},
				});

				// Get GitHub URL using the get_package_github_url tool
				// We need to call it via ctx or use the tool directly
				// Since we can't call tools directly, we'll use the provider logic
				
				// Use the tool via direct execution - but that's not possible from within extension
				// Instead, we'll implement the URL lookup ourselves using npm/pypi APIs
				
				let githubUrl: string | null = null;

				if (normalizedLanguage === "javascript" || normalizedLanguage === "typescript") {
					// Fetch from npm registry
					const npmUrl = `https://registry.npmjs.org/${encodeURIComponent(trimmedPackage)}`;
					const result = await pi.exec("curl", ["-s", "-L", "-w", "\\n%{http_code}", "--max-time", "30", npmUrl]);
					
					if (!result || result.code !== 0) {
						return {
							content: [{ type: "text", text: JSON.stringify({ error: `Failed to fetch package info for '${trimmedPackage}'` }) }],
							details: {},
						};
					}

					const output = result.stdout;
					const lines = output.split("\n");
					const httpCode = lines.pop()?.trim();

					if (httpCode === "404") {
						return {
							content: [{ type: "text", text: JSON.stringify({ error: `Package '${trimmedPackage}' not found in npm registry` }) }],
							details: {},
						};
					}

					if (!httpCode?.startsWith("2")) {
						return {
							content: [{ type: "text", text: JSON.stringify({ error: `npm registry error: HTTP ${httpCode}` }) }],
							details: {},
						};
					}

					const packageJson = JSON.parse(lines.join("\n"));
					
					if (packageJson.repository?.type === "git") {
						// Get the GitHub URL from repository field
						let repoUrl = packageJson.repository.url;
						
						// Convert git:// or https:// to GitHub URL
						if (repoUrl.startsWith("git://")) {
							repoUrl = "https://" + repoUrl.slice(6);
						} else if (repoUrl.startsWith("git+https://")) {
							repoUrl = "https://" + repoUrl.slice(11);
						} else if (repoUrl.startsWith("git@")) {
							// Handle git@github.com:user/repo.git
							repoUrl = "https://" + repoUrl.replace("git@", "").replace(":", "/");
						}
						
						// Remove .git suffix
						githubUrl = repoUrl.replace(/\.git$/, "");
					} else {
						// No repository info, try to construct GitHub URL from package name
						// This is a fallback for packages without repository info
						githubUrl = `https://github.com/${trimmedPackage}`;
					}

				} else if (normalizedLanguage === "python") {
					// Fetch from PyPI
					const pypiUrl = `https://pypi.org/pypi/${encodeURIComponent(trimmedPackage)}/json`;
					const result = await pi.exec("curl", ["-s", "-L", "-w", "\\n%{http_code}", "--max-time", "30", pypiUrl]);
					
					if (!result || result.code !== 0) {
						return {
							content: [{ type: "text", text: JSON.stringify({ error: `Failed to fetch package info for '${trimmedPackage}'` }) }],
							details: {},
						};
					}

					const output = result.stdout;
					const lines = output.split("\n");
					const httpCode = lines.pop()?.trim();

					if (httpCode === "404") {
						return {
							content: [{ type: "text", text: JSON.stringify({ error: `Package '${trimmedPackage}' not found in PyPI registry` }) }],
							details: {},
						};
					}

					if (!httpCode?.startsWith("2")) {
						return {
							content: [{ type: "text", text: JSON.stringify({ error: `PyPI error: HTTP ${httpCode}` }) }],
							details: {},
						};
					}

					const packageInfo = JSON.parse(lines.join("\n"));
					
					if (packageInfo.info?.project_urls?.Repository || packageInfo.info?.project_urls?.Source) {
						let repoUrl = packageInfo.info.project_urls.Repository || packageInfo.info.project_urls.Source;
						
						// Convert various URL formats to GitHub
						if (repoUrl.includes("github.com")) {
							// Already GitHub URL - remove .git suffix
							const cleanedUrl = repoUrl.replace(/\.git$/, "");
							githubUrl = cleanedUrl;
						} else if (repoUrl.startsWith("git://")) {
							githubUrl = "https://" + repoUrl.slice(6).replace(/\.git$/, "");
						} else if (repoUrl.startsWith("git@")) {
							githubUrl = "https://" + repoUrl.replace("git@", "").replace(":", "/").replace(/\.git$/, "");
						}
					} else if (packageInfo.info?.home_page && packageInfo.info.home_page.includes("github.com")) {
						githubUrl = packageInfo.info.home_page.replace(/\.git$/, "");
					}
				}

				if (!githubUrl) {
					return {
						content: [{ type: "text", text: JSON.stringify({ error: `Could not find GitHub repository for package '${trimmedPackage}'` }) }],
						details: {},
					};
				}

				const finalGithubUrl = githubUrl;

				onUpdate?.({
					content: [{ type: "text", text: `Downloading from ${finalGithubUrl}...` }],
					details: {},
				});

				// Determine target path
				const targetDir = getTargetDirectory(packagesDir, normalizedLanguage);
				const packagePath = getPackagePath(targetDir, trimmedPackage);

				// Clone the repository
				await cloneRepository(pi, finalGithubUrl, packagePath);

				// Emit permission allow event for the downloaded package
				// This allows the agent to read the package code without prompting
				const permissionEvent: PermissionAllowEvent = {
					paths: [packagePath, `${packagePath}/**`],
					actions: ["read"],
				};
				pi.events.emit("raw-experience/permission:allow", permissionEvent);
				console.log(`[package-local] Permission allow emitted for: ${packagePath}`);

				const response = {
					path: packagePath,
					status: "downloaded",
					message: `Package '${trimmedPackage}' downloaded to ${path.relative(packagesDir, packagePath)}`,
				};

				return {
					content: [{ type: "text", text: JSON.stringify(response) }],
					details: {},
				};

			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				
				// Check if it's a "already exists" error (race condition)
				if (errorMessage.includes("destination path") && errorMessage.includes("already exists")) {
					const existingPath = await packageExists(packagesDir, normalizedLanguage, trimmedPackage);
					if (existingPath) {
						return {
							content: [{
								type: "text",
								text: JSON.stringify({
									path: existingPath,
									status: "already_exists",
									message: `Package '${trimmedPackage}' already exists`,
								}),
							}],
							details: {},
						};
					}
				}

				return {
					content: [{ type: "text", text: JSON.stringify({ error: `Failed to download package '${trimmedPackage}': ${errorMessage}` }) }],
					details: {},
				};
			}
		},
	});

	// Register a command to list local packages
	pi.registerCommand("packages-list", {
		description: "List locally cached packages",
		handler: async (_args: string, ctx) => {
			try {
				const jsDir = path.join(packagesDir, "JS");
				const pythonDir = path.join(packagesDir, "Python");

				let output = `Local packages directory: ${packagesDir}\n\n`;

				// List JS packages
				if (fs.existsSync(jsDir)) {
					const jsPackages = await fs.promises.readdir(jsDir);
					if (jsPackages.length > 0) {
						output += `JavaScript/TypeScript (${jsPackages.length}):\n`;
						for (const pkg of jsPackages) {
							output += `  - ${pkg}\n`;
						}
					} else {
						output += `JavaScript/TypeScript: none\n`;
					}
				}

				// List Python packages
				if (fs.existsSync(pythonDir)) {
					const pythonPackages = await fs.promises.readdir(pythonDir);
					if (pythonPackages.length > 0) {
						output += `\nPython (${pythonPackages.length}):\n`;
						for (const pkg of pythonPackages) {
							output += `  - ${pkg}\n`;
						}
					} else {
						output += `\nPython: none\n`;
					}
				}

				ctx.ui.notify(output.trim(), "info");
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				ctx.ui.notify(`Error listing packages: ${errorMessage}`, "error");
			}
		},
	});

	console.log("[package-local] Extension initialized");
}

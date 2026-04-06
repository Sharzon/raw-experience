/**
 * get-package-github-url Pi Extension
 * 
 * Extension that provides GitHub URL for packages based on language and package name.
 * Supports Python (PyPI), JavaScript/TypeScript (npm) with GitHub fallback.
 */

import { ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ProviderRegistry } from "./providers/index.js";
import { PyPIProvider } from "./providers/pypi.js";
import { NpmProvider } from "./providers/npm.js";
import { GitHubProvider } from "./providers/github.js";
import type { ProviderResult, SupportedLanguage, ProviderError } from "./types.js";
import { SUPPORTED_LANGUAGES } from "./types.js";

/**
 * HTTP fetcher using pi.exec with curl
 */
function createHttpFetcher(pi: ExtensionAPI): (url: string) => Promise<string | null> {
	return async (url: string): Promise<string | null> => {
		try {
			const result = await pi.exec("curl", ["-s", "-L", "-w", "\\n%{http_code}", "--max-time", "30", url]);

			if (!result) {
				return null;
			}

			// Parse result - curl returns output with HTTP code on separate line
			const output = result.stdout;
			const lines = output.split("\n");
			const httpCode = lines.pop()?.trim();

			if (httpCode === "404") {
				return null;
			}

			if (httpCode === "429") {
				// Rate limited - return special signal
				throw new Error("rate_limit");
			}

			if (!httpCode?.startsWith("2")) {
				return null;
			}

			// Return the content (without the HTTP code line)
			return lines.join("\n");
		} catch (error) {
			if (error instanceof Error && error.message === "rate_limit") {
				throw error;
			}
			return null;
		}
	};
}

export default async function getPackageGithubUrlExtension(pi: ExtensionAPI): Promise<void> {
	console.log("[get-package-github-url] Extension loaded");

	// Create HTTP fetcher
	const httpFetcher = createHttpFetcher(pi);

	// Create and configure providers
	const registry = new ProviderRegistry();

	// Register PyPI provider for Python
	registry.register(new PyPIProvider(httpFetcher));

	// Register npm provider for JavaScript/TypeScript
	registry.register(new NpmProvider(httpFetcher));

	// Register GitHub fallback (doesn't support any language directly, used as fallback)
	const githubProvider = new GitHubProvider(httpFetcher);

	// Validate registry
	const validation = registry.validate();
	if (!validation.valid) {
		console.error(
			`[get-package-github-url] Warning: Missing providers for languages: ${validation.missing.join(", ")}`
		);
	}

	// Register the tool
	pi.registerTool({
		name: "get_package_github_url",
		label: "Get Package GitHub URL",
		description: "Get GitHub repository URL for a package by language and package name. Supports Python (PyPI), JavaScript/TypeScript (npm).",
		parameters: Type.Object({
			language: Type.Union([
				Type.Literal("python"),
				Type.Literal("javascript"),
				Type.Literal("typescript"),
			], { description: "Programming language: python, javascript, or typescript" }),
			package: Type.String({ description: "Package name" }),
		}),
		async execute(toolCallId: string, params: { language: "python" | "javascript" | "typescript"; package: string }, signal: AbortSignal | undefined, onUpdate: ((partialResult: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined, ctx: ExtensionContext): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
			const { language, package: packageName } = params as {
				language: "python" | "javascript" | "typescript";
				package: string;
			};

			// Validate inputs
			if (!SUPPORTED_LANGUAGES.includes(language)) {
				const errorResponse: ProviderError = { error: `Unsupported language: ${language}` };
				return {
					content: [{ type: "text", text: JSON.stringify(errorResponse) }],
					details: {},
				};
			}

			if (!packageName || packageName.trim() === "") {
				const errorResponse: ProviderError = { error: "Package name cannot be empty" };
				return {
					content: [{ type: "text", text: JSON.stringify(errorResponse) }],
					details: {},
				};
			}

			const trimmedPackage = packageName.trim();

			try {
				// Get providers for the language
				const providers = registry.getProvidersForLanguage(language as SupportedLanguage);

				let githubUrl: string | null = null;
				let providerName = "";

				// Try each provider in order
				for (const provider of providers) {
					try {
						githubUrl = await provider.getGithubUrl(trimmedPackage);

						if (githubUrl) {
							// Determine provider name for response
							if (provider instanceof PyPIProvider) {
								providerName = "pypi";
							} else if (provider instanceof NpmProvider) {
								providerName = "npm";
							}
							break;
						}
					} catch (error) {
						// Check for rate limit
						if (error instanceof Error && error.message === "rate_limit") {
							console.log(`[get-package-github-url] Rate limited by ${providerName || "unknown provider"}, trying next...`);
							continue;
						}
						// Other errors - try next provider
						continue;
					}
				}

				// If not found by primary providers, try GitHub fallback
				if (!githubUrl) {
					console.log(`[get-package-github-url] Package not found in primary providers, trying GitHub fallback...`);
					githubUrl = await githubProvider.getGithubUrl(trimmedPackage);
					if (githubUrl) {
						providerName = "github_fallback";
					}
				}

				// Return result
				if (githubUrl) {
					const result: ProviderResult = {
						github_url: githubUrl,
						provider: providerName,
					};
					return {
						content: [{ type: "text", text: JSON.stringify(result) }],
						details: {},
					};
				} else {
					const errorResponse: ProviderError = { error: `Package "${trimmedPackage}" not found` };
					return {
						content: [{ type: "text", text: JSON.stringify(errorResponse) }],
						details: {},
					};
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : "Unknown error";
				const errorResponse: ProviderError = { error: `Error fetching package info: ${errorMessage}` };
				return {
					content: [{ type: "text", text: JSON.stringify(errorResponse) }],
					details: {},
				};
			}
		},
	});

	console.log("[get-package-github-url] Extension initialized");
}

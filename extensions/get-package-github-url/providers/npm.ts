/**
 * npm Provider - gets GitHub URL from npm registry package info
 */

import type { Provider } from "../types.js";
import type { HttpFetcher } from "./pypi.js";

export class NpmProvider implements Provider {
	readonly supportedLanguages = ["javascript", "typescript"];

	constructor(private fetch: HttpFetcher) {}

	async getGithubUrl(packageName: string): Promise<string | null> {
		const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;

		const result = await this.fetch(url);

		if (!result) {
			return null;
		}

		try {
			const data = JSON.parse(result);

			// Try repository field
			const repository = data?.repository;
			if (repository) {
				let repoUrl: string | undefined;

				if (typeof repository === "string") {
					repoUrl = repository;
				} else if (typeof repository === "object") {
					repoUrl = repository.url as string;
				}

				if (repoUrl?.includes("github.com")) {
					const githubUrl = this.extractGithubUrl(repoUrl);
					if (githubUrl) {
						return githubUrl;
					}
				}
			}

			// Try homepage field
			const homepage = data?.homepage as string | undefined;
			if (homepage?.includes("github.com")) {
				const githubUrl = this.extractGithubUrl(homepage);
				if (githubUrl) {
					return githubUrl;
				}
			}

			return null;
		} catch {
			return null;
		}
	}

	private extractGithubUrl(url: string): string | null {
		// Normalize GitHub URL to standard format
		let normalized = url.trim();

		// Handle various URL formats that npm might return
		// e.g., "git+https://github.com/user/repo.git" or "git://github.com/user/repo.git"

		// Remove git+ prefix
		if (normalized.startsWith("git+")) {
			normalized = normalized.slice(4);
		}

		// Remove git: prefix
		if (normalized.startsWith("git:")) {
			normalized = normalized.slice(4);
		}

		// Convert git: or git+ to https:
		if (normalized.startsWith("git://")) {
			normalized = "https://" + normalized.slice(6);
		}

		// Remove .git suffix
		if (normalized.endsWith(".git")) {
			normalized = normalized.slice(0, -4);
		}

		// Remove trailing slash
		if (normalized.endsWith("/")) {
			normalized = normalized.slice(0, -1);
		}

		// Ensure it starts with https://github.com
		if (normalized.includes("github.com")) {
			const match = normalized.match(/https?:\/\/github\.com\/[^\/]+\/[^\/]+/);
			if (match) {
				return match[0];
			}
		}

		return null;
	}
}

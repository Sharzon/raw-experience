/**
 * PyPI Provider - gets GitHub URL from PyPI package info
 */

import type { Provider } from "../types.js";

export type HttpFetcher = (url: string) => Promise<string | null>;

export class PyPIProvider implements Provider {
	readonly supportedLanguages = ["python"];

	constructor(private fetch: HttpFetcher) {}

	async getGithubUrl(packageName: string): Promise<string | null> {
		const url = `https://pypi.org/pypi/${encodeURIComponent(packageName)}/json`;

		const result = await this.fetch(url);

		if (!result) {
			return null;
		}

		try {
			const data = JSON.parse(result);

			// Try to find GitHub URL in project_urls
			const projectUrls = data?.info?.project_urls || {};
			for (const [key, value] of Object.entries(projectUrls)) {
				const urlValue = value as string;
				if (
					key.toLowerCase().includes("github") ||
					key.toLowerCase().includes("repository") ||
					key.toLowerCase().includes("source") ||
					urlValue.includes("github.com")
				) {
					// Extract clean GitHub URL
					const githubUrl = this.extractGithubUrl(urlValue);
					if (githubUrl) {
						return githubUrl;
					}
				}
			}

			// Try homepage field
			const homepage = data?.info?.homepage as string | undefined;
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
		// Remove .git suffix, trailing slashes, etc.
		let normalized = url.trim();

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
			// Extract clean URL
			const match = normalized.match(/https?:\/\/github\.com\/[^\/]+\/[^\/]+/);
			if (match) {
				return match[0];
			}
		}

		return null;
	}
}

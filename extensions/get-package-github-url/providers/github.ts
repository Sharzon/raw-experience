/**
 * GitHub Fallback Provider - searches for repository by package name
 * Used when primary providers (PyPI, npm) don't find the package
 */

import type { Provider } from "../types.js";
import type { HttpFetcher } from "./pypi.js";

export class GitHubProvider implements Provider {
	readonly supportedLanguages: string[] = [];

	constructor(private fetch: HttpFetcher) {}

	async getGithubUrl(packageName: string): Promise<string | null> {
		// Use GitHub Search API to find repository
		const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(packageName + " in:name")}&per_page=1`;

		const result = await this.fetch(url);

		if (!result) {
			return null;
		}

		try {
			const data = JSON.parse(result);

			// Check if we got results
			if (data?.items && data.items.length > 0) {
				const repo = data.items[0];
				return repo.html_url;
			}

			return null;
		} catch {
			return null;
		}
	}
}

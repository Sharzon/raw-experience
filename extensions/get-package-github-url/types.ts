/**
 * TypeScript types for get-package-github-url extension
 */

export interface ProviderResult {
	github_url: string;
	provider: string;
}

export interface Provider {
	readonly supportedLanguages: string[];
	getGithubUrl(packageName: string): Promise<string | null>;
}

export const SUPPORTED_LANGUAGES = ["python", "javascript", "typescript"] as const;
export type SupportedLanguage = typeof SUPPORTED_LANGUAGES[number];

export interface ProviderError {
	error: string;
}

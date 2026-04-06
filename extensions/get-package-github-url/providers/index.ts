/**
 * Provider Registry - manages and validates providers
 */

import type { Provider, SupportedLanguage } from "../types.js";
import { SUPPORTED_LANGUAGES } from "../types.js";

export class ProviderRegistry {
	private providers: Provider[] = [];

	register(provider: Provider): void {
		this.providers.push(provider);
	}

	/**
	 * Get providers for a specific language
	 */
	getProvidersForLanguage(language: SupportedLanguage): Provider[] {
		return this.providers.filter((p) => p.supportedLanguages.includes(language));
	}

	/**
	 * Validate that all supported languages are covered by at least one provider
	 */
	validate(): { valid: boolean; missing: SupportedLanguage[] } {
		const coveredLanguages = new Set<SupportedLanguage>();

		for (const provider of this.providers) {
			for (const lang of provider.supportedLanguages) {
				if (SUPPORTED_LANGUAGES.includes(lang as SupportedLanguage)) {
					coveredLanguages.add(lang as SupportedLanguage);
				}
			}
		}

		const missing = SUPPORTED_LANGUAGES.filter((lang) => !coveredLanguages.has(lang));

		return {
			valid: missing.length === 0,
			missing,
		};
	}
}

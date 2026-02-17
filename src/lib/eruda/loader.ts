import { BROWSER, DEV } from 'esm-env';
import type { GgErudaOptions } from './types.js';

/**
 * Checks if any production trigger is active
 */
function checkProdTriggers(
	triggers: Array<'url-param' | 'localStorage' | 'gesture'> | string | false
): boolean {
	if (!BROWSER) return false;
	if (triggers === false) return false;

	const triggerArray = Array.isArray(triggers) ? triggers : [triggers];

	for (const trigger of triggerArray) {
		if (trigger === 'url-param') {
			try {
				const params = new URLSearchParams(window.location.search);
				if (params.has('gg')) {
					// Persist the decision
					localStorage.setItem('gg-enabled', 'true');
					return true;
				}
			} catch {
				// URLSearchParams might not be available
			}
		}

		if (trigger === 'localStorage') {
			try {
				if (localStorage.getItem('gg-enabled') === 'true') {
					return true;
				}
			} catch {
				// localStorage might not be available
			}
		}

		if (trigger === 'gesture') {
			// TODO: Implement 5-tap gesture detection
			// For now, fall through
		}
	}

	return false;
}

/**
 * Determines if Eruda should be loaded based on environment and triggers
 */
export function shouldLoadEruda(options: GgErudaOptions): boolean {
	if (!BROWSER) return false;

	// Development - always load
	if (DEV) return true;

	// Production - check triggers
	const prodTriggers = options.prod ?? ['url-param', 'gesture'];
	return checkProdTriggers(prodTriggers);
}

/**
 * Dynamically imports and initializes Eruda
 */
export async function loadEruda(options: GgErudaOptions): Promise<void> {
	if (!BROWSER) return;

	try {
		// Dynamic import of Eruda
		const erudaModule = await import('eruda');
		const eruda = erudaModule.default;

		// Clear Eruda position state to prevent icon from being stuck in wrong position
		// Eruda stores draggable icon position in localStorage which can get corrupted
		// This ensures the icon always appears in the default bottom-right corner
		try {
			// Eruda uses keys like 'eruda-entry-button' for position state
			const positionKeys = ['eruda-entry-button', 'eruda-position'];
			positionKeys.forEach((key) => localStorage.removeItem(key));
		} catch {
			// localStorage might not be available
		}

		// Initialize Eruda
		eruda.init({
			...options.erudaOptions,
			// Ensure tool is always visible in case user customizes
			tool: ['console', 'elements', 'network', 'resources', 'info', 'snippets', 'sources']
		});

		// Register gg plugin
		// Import gg and pass it to the plugin directly
		const { gg, runGgDiagnostics } = await import('../gg.js');
		const { createGgPlugin } = await import('./plugin.js');
		const ggPlugin = createGgPlugin(options, gg);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		eruda.add(ggPlugin as any);

		// Make GG tab the default selected tab
		eruda.show('GG');
		// Expand the Eruda panel (open from minimized floating button state)
		eruda.show();

		// Run diagnostics after Eruda is ready so they appear in Console tab
		await runGgDiagnostics();
	} catch (error) {
		console.error('[gg] Failed to load Eruda:', error);
	}
}

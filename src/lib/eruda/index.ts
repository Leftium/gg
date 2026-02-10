import { BROWSER } from 'esm-env';
import type { GgErudaOptions } from './types.js';
import { shouldLoadEruda, loadEruda } from './loader.js';

// Re-export types for consumers
export type { GgErudaOptions, CapturedEntry, ErudaPlugin } from './types.js';

let initialized = false;

/**
 * Initialize the gg Eruda plugin
 *
 * In development, loads Eruda eagerly.
 * In production, loads only when triggers fire.
 *
 * @example
 * ```ts
 * import { initGgEruda } from '@leftium/gg/eruda';
 *
 * // Simple usage - works in dev, respects ?gg in prod
 * initGgEruda();
 *
 * // Custom triggers
 * initGgEruda({
 *   prod: 'url-param', // Only ?gg trigger, no gesture
 *   maxEntries: 5000,
 *   autoEnable: true
 * });
 * ```
 */
export function initGgEruda(options: GgErudaOptions = {}): void {
	// Only run in browser
	if (!BROWSER) return;

	// Prevent double initialization
	if (initialized) {
		console.warn('[gg] initGgEruda() called multiple times. Ignoring subsequent calls.');
		return;
	}

	initialized = true;

	// Check if we should load Eruda
	if (!shouldLoadEruda(options)) {
		// In production without triggers, set up gesture detection if enabled
		const prodTriggers = options.prod ?? ['url-param', 'gesture'];
		const triggerArray = Array.isArray(prodTriggers) ? prodTriggers : [prodTriggers];

		if (triggerArray.includes('gesture')) {
			setupGestureDetection(options);
		}

		return;
	}

	// Load Eruda
	loadEruda(options);
}

/**
 * Set up 5-tap gesture detection for production
 */
function setupGestureDetection(options: GgErudaOptions): void {
	let tapCount = 0;
	let tapTimer: ReturnType<typeof setTimeout> | null = null;

	const resetTaps = () => {
		tapCount = 0;
		if (tapTimer) clearTimeout(tapTimer);
		tapTimer = null;
	};

	document.addEventListener('click', () => {
		tapCount++;

		// Reset timer on each tap
		if (tapTimer) clearTimeout(tapTimer);

		// If 5 taps detected, load Eruda
		if (tapCount >= 5) {
			console.log('[gg] 5 taps detected, loading Eruda...');
			// Persist the decision
			try {
				localStorage.setItem('gg-enabled', 'true');
			} catch {
				// localStorage might not be available
			}
			loadEruda(options);
			resetTaps();
			return;
		}

		// Reset after 1 second of no taps
		tapTimer = setTimeout(resetTaps, 1000);
	});
}

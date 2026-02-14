/**
 * Debug entry point — selects browser or node implementation.
 *
 * Uses a lazy initialization pattern to avoid top-level await,
 * which has incomplete Safari support and breaks SSR-disabled pages.
 * The debug factory is loaded on first use via a synchronous getter
 * backed by a pre-started import promise.
 *
 * Re-exports the DebugFactory and Debugger types for consumers.
 */

import { BROWSER } from 'esm-env';
import type { DebugFactory, Debugger } from './common.js';

export type { DebugFactory, Debugger } from './common.js';

// Start loading the platform-specific implementation immediately (non-blocking).
// The promise begins resolving at module load time but doesn't block evaluation.
let _debug: DebugFactory | null = null;

const _ready: Promise<void> = (BROWSER ? import('./browser.js') : import('./node.js')).then(
	(m) => {
		_debug = m.default as DebugFactory;
	}
);

/**
 * Ensure the debug factory is loaded. In practice, the dynamic import resolves
 * almost instantly (it's a local module, not a network fetch), so by the time
 * any consumer calls debugFactory() the promise is already settled.
 *
 * For the rare case where it's called before resolution, this returns a
 * no-op debugger that buffers nothing — acceptable since gg diagnostics
 * and early logging are already deferred in practice.
 */
function getDebugFactory(): DebugFactory {
	if (_debug) return _debug;

	// Fallback: return a minimal no-op factory while the real one loads.
	// This path is hit only if someone calls debugFactory() synchronously
	// during module evaluation, before the microtask resolves.
	const noop = Object.assign(
		function noopDebug(_namespace: string): Debugger {
			// Return a disabled debugger stub
			const stub = Object.assign(
				function (..._args: unknown[]) {},
				{
					namespace: _namespace,
					enabled: false,
					color: '0',
					diff: 0,
					useColors: false,
					log: () => {},
					extend: (sub: string) => noopDebug(`${_namespace}:${sub}`),
					destroy: () => stub,
					formatArgs: undefined as ((args: unknown[]) => void) | undefined
				}
			);
			return stub as unknown as Debugger;
		},
		{
			enable: (_namespaces: string) => {},
			disable: () => '',
			enabled: (_namespace: string) => false,
			names: [] as RegExp[],
			skips: [] as RegExp[]
		}
	);
	return noop as unknown as DebugFactory;
}

/**
 * Promise that resolves when the debug factory is ready.
 * Consumers that need to guarantee the factory is loaded can await this.
 */
export const debugReady: Promise<void> = _ready;

/**
 * Proxy-based default export that delegates to the real debug factory
 * once loaded. This allows `import debug from './debug/index.js'` to
 * work as a synchronous import while the actual implementation loads
 * in the background.
 */
const debug: DebugFactory = new Proxy((() => {}) as unknown as DebugFactory, {
	apply(_target, _thisArg, args) {
		return getDebugFactory()(args[0] as string);
	},
	get(_target, prop, _receiver) {
		const factory = getDebugFactory();
		return (factory as unknown as Record<string | symbol, unknown>)[prop];
	}
});

export default debug;

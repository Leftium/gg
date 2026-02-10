import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

export default {
	input: 'src/lib/debug/src/index.js',
	output: {
		file: 'src/lib/debug-bundled.js',
		format: 'es',
		sourcemap: false,
		banner: '// @ts-nocheck\n// Auto-generated bundled debug library - type checking disabled'
	},
	plugins: [
		nodeResolve(),
		commonjs(),
		terser({
			format: {
				comments: false, // Remove all comments
				preamble: '// @ts-nocheck\n// Auto-generated bundled debug library - type checking disabled'
			}
		})
	]
};

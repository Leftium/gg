import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import terser from '@rollup/plugin-terser';

export default {
	input: 'src/lib/debug/src/index.js',
	output: {
		file: 'src/lib/debug-bundled.js',
		format: 'es',
		sourcemap: false
	},
	plugins: [nodeResolve(), commonjs(), terser()]
};

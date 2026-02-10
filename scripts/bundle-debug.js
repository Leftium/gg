#!/usr/bin/env node
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

console.log('📦 Bundling patched debug library...');

try {
	const { stdout, stderr } = await execAsync('rollup -c rollup.config.debug.js');

	if (stdout) console.log(stdout);
	if (stderr) console.error(stderr);

	console.log('✓ Debug library bundled to src/lib/debug-bundled.js');
} catch (error) {
	console.error('❌ Failed to bundle debug:', error.message);
	process.exit(1);
}

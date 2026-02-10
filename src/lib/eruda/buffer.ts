import type { CapturedEntry } from './types.js';

/**
 * Ring buffer for captured log entries
 */
export class LogBuffer {
	private entries: CapturedEntry[] = [];
	private maxSize: number;

	constructor(maxSize: number = 2000) {
		this.maxSize = maxSize;
	}

	/**
	 * Add an entry to the buffer
	 * If buffer is full, oldest entry is removed
	 */
	push(entry: CapturedEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxSize) {
			this.entries.shift(); // Remove oldest
		}
	}

	/**
	 * Get all entries (optionally filtered)
	 */
	getEntries(filter?: (entry: CapturedEntry) => boolean): CapturedEntry[] {
		if (!filter) return [...this.entries];
		return this.entries.filter(filter);
	}

	/**
	 * Clear all entries
	 */
	clear(): void {
		this.entries = [];
	}

	/**
	 * Get entry count
	 */
	get size(): number {
		return this.entries.length;
	}
}

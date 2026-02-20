import type { CapturedEntry } from './types.js';

/**
 * Ring buffer for captured log entries.
 *
 * Uses a fixed-size array with a head pointer so that push() is always O(1).
 * The previous implementation used Array.push + Array.shift which is O(n)
 * once the buffer is full (every shift copies all elements forward).
 */
export class LogBuffer {
	private buf: (CapturedEntry | undefined)[];
	private head = 0; // index of the oldest entry
	private count = 0; // number of live entries
	private maxSize: number;
	private _totalPushed = 0;

	constructor(maxSize: number = 2000) {
		this.maxSize = maxSize;
		this.buf = new Array(maxSize);
	}

	/**
	 * Add an entry to the buffer — O(1) always.
	 * If buffer is full, the oldest entry is overwritten.
	 */
	push(entry: CapturedEntry): void {
		this._totalPushed++;
		if (this.count < this.maxSize) {
			// Buffer not yet full — append at head + count
			this.buf[(this.head + this.count) % this.maxSize] = entry;
			this.count++;
		} else {
			// Overwrite oldest entry, advance head
			this.buf[this.head] = entry;
			this.head = (this.head + 1) % this.maxSize;
		}
	}

	/**
	 * Get a single entry by logical index (0 = oldest). O(1).
	 * Returns undefined if index is out of range.
	 */
	get(index: number): CapturedEntry | undefined {
		if (index < 0 || index >= this.count) return undefined;
		return this.buf[(this.head + index) % this.maxSize];
	}

	/**
	 * Get a range of entries [start, end) by logical index. O(end - start).
	 * Clamps to valid range. Returns a new array.
	 */
	getRange(start: number, end: number): CapturedEntry[] {
		const s = Math.max(0, start);
		const e = Math.min(this.count, end);
		const result: CapturedEntry[] = [];
		for (let i = s; i < e; i++) {
			result.push(this.buf[(this.head + i) % this.maxSize]!);
		}
		return result;
	}

	/**
	 * Get all entries in insertion order (optionally filtered).
	 * Allocates a new array — used for full renders, not the hot path.
	 */
	getEntries(filter?: (entry: CapturedEntry) => boolean): CapturedEntry[] {
		const result: CapturedEntry[] = [];
		for (let i = 0; i < this.count; i++) {
			const entry = this.buf[(this.head + i) % this.maxSize]!;
			if (!filter || filter(entry)) {
				result.push(entry);
			}
		}
		return result;
	}

	/**
	 * Clear all entries
	 */
	clear(): void {
		this.buf = new Array(this.maxSize);
		this.head = 0;
		this.count = 0;
		this._totalPushed = 0;
	}

	/**
	 * Get entry count
	 */
	get size(): number {
		return this.count;
	}

	/**
	 * Get total entries ever pushed (including evicted ones)
	 */
	get totalPushed(): number {
		return this._totalPushed;
	}

	/**
	 * Get number of entries evicted due to buffer overflow
	 */
	get evicted(): number {
		return this._totalPushed - this.count;
	}

	/**
	 * Get the maximum capacity
	 */
	get capacity(): number {
		return this.maxSize;
	}
}

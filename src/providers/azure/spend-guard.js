/**
 * Per-day token ceiling counted from Azure usage.total_tokens.
 * The file stores only a UTC day and a number.
 */

import fs from 'fs';
import path from 'path';
import { Mutex } from 'async-mutex';

export class SpendGuard {
    /**
     * @param {{ filePath: string, ceiling: number }} options
     */
    constructor({ filePath, ceiling }) {
        if (!filePath) throw new Error('Spend file path is required');
        if (!Number.isInteger(ceiling) || ceiling < 0) {
            throw new Error('Daily token ceiling must be a non-negative integer');
        }
        this.filePath = filePath;
        this.ceiling = ceiling;
        this.mutex = new Mutex();
        this.state = this.#load();
    }

    #today() {
        return new Date().toISOString().slice(0, 10);
    }

    #load() {
        const today = this.#today();
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (parsed.day === today && Number.isInteger(parsed.totalTokens) && parsed.totalTokens >= 0) {
                return { day: today, totalTokens: parsed.totalTokens, reserved: 0 };
            }
        } catch {
            // A missing counter starts at zero. A corrupt file does too.
        }
        return { day: today, totalTokens: 0, reserved: 0 };
    }

    #rollDay() {
        const today = this.#today();
        if (this.state.day !== today) {
            this.state = { day: today, totalTokens: 0, reserved: 0 };
        }
    }

    #persist() {
        const body = JSON.stringify({
            day: this.state.day,
            totalTokens: this.state.totalTokens
        });
        const dir = path.dirname(this.filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
        try {
            if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath, { force: true });
            fs.renameSync(tmp, this.filePath);
        } catch {
            fs.writeFileSync(this.filePath, body, { encoding: 'utf8', mode: 0o600 });
            fs.rmSync(tmp, { force: true });
        }
    }

    /**
     * Reserve part of the remaining daily budget before calling Azure.
     * @param {number} outputCap
     * @returns {Promise<number>} tokens reserved
     */
    async beforeRequest(outputCap) {
        const cap = Math.max(1, Math.floor(outputCap) || 1);
        return this.mutex.runExclusive(() => {
            this.#rollDay();
            if (this.state.totalTokens >= this.ceiling) {
                const error = new Error('Daily token ceiling reached');
                error.code = 'CEILING';
                throw error;
            }
            const remaining = this.ceiling - this.state.totalTokens - this.state.reserved;
            if (remaining <= 0) {
                const error = new Error('Daily token ceiling reached');
                error.code = 'CEILING';
                throw error;
            }
            const reserve = Math.min(cap, remaining);
            this.state.reserved += reserve;
            return reserve;
        });
    }

    /**
     * Replace a reservation with the real Azure total_tokens count.
     * @param {number} reserved
     * @param {number} actualTotal
     */
    async commit(reserved, actualTotal) {
        const add = Number.isFinite(actualTotal) && actualTotal > 0 ? Math.floor(actualTotal) : 0;
        return this.mutex.runExclusive(() => {
            this.#rollDay();
            this.state.reserved = Math.max(0, this.state.reserved - (reserved || 0));
            this.state.totalTokens += add;
            this.#persist();
        });
    }

    /**
     * @param {number} reserved
     */
    async cancel(reserved) {
        return this.commit(reserved, 0);
    }

    snapshot() {
        this.#rollDay();
        return {
            day: this.state.day,
            totalTokens: this.state.totalTokens,
            ceiling: this.ceiling
        };
    }
}

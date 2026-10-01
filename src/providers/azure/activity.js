/**
 * Recent request log for the local usage page.
 * Stores counts and model names only. Never prompts, headers, or keys.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { Mutex } from 'async-mutex';

const MAX_REQUESTS = 200;

export class RequestActivity {
    /**
     * @param {string} filePath
     */
    constructor(filePath) {
        this.filePath = filePath;
        this.mutex = new Mutex();
        this.requests = this.#load();
    }

    #load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            if (Array.isArray(parsed.requests)) return parsed.requests.slice(-MAX_REQUESTS);
        } catch {
            // A missing log starts empty.
        }
        return [];
    }

    #persist() {
        const body = JSON.stringify({ requests: this.requests });
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
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
     * @param {object} entry
     */
    async record(entry) {
        const row = {
            id: crypto.randomBytes(8).toString('hex'),
            at: new Date().toISOString(),
            model: clip(entry.model),
            deployment: clip(entry.deployment),
            stream: Boolean(entry.stream),
            status: number(entry.status),
            inputTokens: number(entry.inputTokens),
            freshTokens: optionalNumber(entry.freshTokens),
            outputTokens: number(entry.outputTokens),
            cachedTokens: number(entry.cachedTokens),
            cacheWriteTokens: optionalNumber(entry.cacheWriteTokens),
            reasoningTokens: optionalNumber(entry.reasoningTokens),
            promptTokens: optionalNumber(entry.promptTokens),
            totalTokens: number(entry.totalTokens),
            durationMs: number(entry.durationMs),
            stopReason: clip(entry.stopReason)
        };
        await this.mutex.runExclusive(() => {
            this.requests.push(row);
            if (this.requests.length > MAX_REQUESTS) {
                this.requests.splice(0, this.requests.length - MAX_REQUESTS);
            }
            this.#persist();
        });
        return row;
    }

    snapshot() {
        return this.requests.slice().reverse();
    }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function clip(value) {
    return String(value || '').slice(0, 120);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function number(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
}

/**
 * Missing means "not reported", which is different from a real zero.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function optionalNumber(value) {
    if (value == null || value === '') return undefined;
    return number(value);
}

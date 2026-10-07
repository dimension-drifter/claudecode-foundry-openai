/**
 * GPT-6 tool calls return a reasoning item with encrypted_content when the
 * Responses request is stateless. The next request has to send that item
 * back with the tool call, or the model starts its plan over.
 * Claude Code has no field for this blob, so it stays on disk keyed by call id.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * @param {object} item
 * @returns {object|null}
 */
export function replayReasoningItem(item) {
    const encrypted = item?.encrypted_content;
    const id = item?.id;
    if (item?.type !== 'reasoning') return null;
    if (typeof id !== 'string' || !id) return null;
    if (typeof encrypted !== 'string' || !encrypted) return null;
    return {
        type: 'reasoning',
        id,
        summary: Array.isArray(item.summary) ? item.summary : [],
        encrypted_content: encrypted
    };
}

/**
 * @param {object[]|undefined} output Responses `output` array, in order
 * @returns {object|null}
 */
export function traceFromOutput(output) {
    if (!Array.isArray(output)) return null;
    const items = [];
    const callIds = [];
    /** @type {Record<string, string>} */
    const callItemIds = {};
    let lead = 'tools';
    let seenReasoning = false;
    let seenText = false;
    for (const item of output) {
        if (item?.type === 'reasoning') {
            const replay = replayReasoningItem(item);
            if (!replay) continue;
            if (!seenReasoning && !seenText) lead = 'reasoning';
            seenReasoning = true;
            items.push(replay);
            continue;
        }
        if (item?.type === 'message') {
            const text = (item.content || []).map((part) => part?.text || '').join('');
            if (!text) continue;
            if (!seenReasoning && !seenText) lead = 'text';
            seenText = true;
            continue;
        }
        if (item?.type === 'function_call' && item.call_id) {
            const callId = String(item.call_id);
            callIds.push(callId);
            if (typeof item.id === 'string' && item.id) callItemIds[callId] = item.id;
        }
    }
    if (!items.length || !callIds.length) return null;
    return { callIds, items, callItemIds, lead };
}

/**
 * @param {object[]|undefined} output
 * @returns {object[]}
 */
export function reasoningItemsFromOutput(output) {
    if (!Array.isArray(output)) return [];
    const items = [];
    for (const item of output) {
        const replay = replayReasoningItem(item);
        if (replay) items.push(replay);
    }
    return items;
}

/**
 * @param {string} directory
 */
export function createReasoningCache(directory) {
    /** @type {Map<string, object>} */
    const memory = new Map();

    function fileFor(callId) {
        const safe = String(callId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
        if (!safe) return null;
        return path.join(directory, `${safe}.json`);
    }

    function encFile(encrypted) {
        const hash = crypto.createHash('sha256').update(encrypted).digest('hex').slice(0, 32);
        return path.join(directory, `e-${hash}.json`);
    }

    function writeJson(file, body) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
        try {
            if (fs.existsSync(file)) fs.rmSync(file, { force: true });
            fs.renameSync(tmp, file);
        } catch {
            fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
            fs.rmSync(tmp, { force: true });
        }
    }

    function remember(trace) {
        for (const callId of trace.callIds || []) memory.set(callId, trace);
        for (const item of trace.items || []) {
            if (item?.encrypted_content) memory.set(`enc:${item.encrypted_content}`, item);
        }
    }

    function fresh(trace) {
        const savedAt = Number(trace?.savedAt || 0);
        return trace?.items?.length && Date.now() - savedAt < TTL_MS;
    }

    return {
        /**
         * @param {object|null} trace
         */
        save(trace) {
            if (!trace?.callIds?.length || !trace.items?.length) return;
            const stored = { ...trace, savedAt: Date.now() };
            remember(stored);
            fs.mkdirSync(directory, { recursive: true });
            const body = JSON.stringify(stored);
            for (const callId of stored.callIds) {
                const file = fileFor(callId);
                if (file) writeJson(file, body);
            }
            for (const item of stored.items) {
                if (item?.encrypted_content) writeJson(encFile(item.encrypted_content), JSON.stringify({ item, savedAt: stored.savedAt }));
            }
            prune(directory);
        },
        /**
         * Text-only turns have a scratchpad and no tool id.
         * @param {object[]} items
         */
        saveItems(items) {
            if (!Array.isArray(items) || !items.length) return;
            const stored = { callIds: [], items, savedAt: Date.now() };
            remember(stored);
            fs.mkdirSync(directory, { recursive: true });
            for (const item of items) {
                if (item?.encrypted_content) writeJson(encFile(item.encrypted_content), JSON.stringify({ item, savedAt: stored.savedAt }));
            }
        },
        /**
         * @param {string[]} callIds
         * @returns {object|null}
         */
        lookup(callIds) {
            for (const callId of callIds || []) {
                const cached = memory.get(callId);
                if (cached) {
                    if (fresh(cached)) return cached;
                    memory.delete(callId);
                }
                const file = fileFor(callId);
                if (!file || !fs.existsSync(file)) continue;
                try {
                    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                    if (!fresh(parsed)) {
                        fs.rmSync(file, { force: true });
                        continue;
                    }
                    remember(parsed);
                    return parsed;
                } catch {
                    continue;
                }
            }
            return null;
        },
        /**
         * Original reasoning item for a scratchpad Claude Code sent back.
         * @param {string} encrypted
         * @returns {object|null}
         */
        lookupEncrypted(encrypted) {
            if (typeof encrypted !== 'string' || !encrypted) return null;
            const key = `enc:${encrypted}`;
            const cached = memory.get(key);
            if (cached?.encrypted_content) return cached;
            const file = encFile(encrypted);
            if (!fs.existsSync(file)) return null;
            try {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (!parsed?.item?.encrypted_content) return null;
                if (Date.now() - Number(parsed.savedAt || 0) >= TTL_MS) {
                    fs.rmSync(file, { force: true });
                    return null;
                }
                memory.set(key, parsed.item);
                return parsed.item;
            } catch {
                return null;
            }
        }
    };
}

/**
 * @param {string} directory
 */
function prune(directory) {
    let names = [];
    try {
        names = fs.readdirSync(directory);
    } catch {
        return;
    }
    const cutoff = Date.now() - TTL_MS;
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(directory, name);
        try {
            if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
        } catch {
            // A file removed by another request is already gone.
        }
    }
}

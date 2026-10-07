/**
 * GPT-6 tool calls return a reasoning item with encrypted_content when the
 * Responses request is stateless. The next request has to send that item
 * back with the tool call, or the model starts its plan over.
 * Claude Code has no field for this blob, so it stays on disk keyed by call id.
 */

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

    function remember(trace) {
        for (const callId of trace.callIds || []) memory.set(callId, trace);
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
                if (!file) continue;
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
            prune(directory);
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

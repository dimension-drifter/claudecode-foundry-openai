/**
 * OpenAI function names are at most 64 characters and must match [A-Za-z0-9_-].
 * Shortening is deterministic so the same Anthropic tool name always maps back.
 */

import crypto from 'crypto';

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * @param {string} name
 * @returns {string}
 */
export function shortenToolName(name) {
    const raw = String(name || 'tool');
    if (raw.length <= 64 && SAFE_NAME.test(raw)) return raw;

    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 15);
    const sanitized = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+/, '') || 'tool';
    let short = `${sanitized.slice(0, 48)}_${hash}`;
    if (!SAFE_NAME.test(short) || short.length > 64) {
        short = `tool_${hash}`;
    }
    return short.slice(0, 64);
}

/**
 * @param {string[]} names
 * @returns {{ shorten: (name: string) => string, restore: (name: string) => string }}
 */
export function buildNameMap(names) {
    const toShort = new Map();
    const toLong = new Map();
    const used = new Set();

    for (const name of names) {
        if (!name || toShort.has(name)) continue;
        let short = shortenToolName(name);
        const owner = toLong.get(short);
        if (owner && owner !== name) {
            const hash = crypto.createHash('sha256').update(`collision:${name}`).digest('hex').slice(0, 15);
            short = `t_${hash}`;
        }
        used.add(short);
        toShort.set(name, short);
        toLong.set(short, name);
    }

    return {
        shorten(name) {
            if (toShort.has(name)) return toShort.get(name);
            const short = shortenToolName(name);
            return toLong.has(short) ? short : short;
        },
        restore(name) {
            return toLong.get(name) || name;
        },
        used
    };
}

/**
 * @param {object} body Anthropic request
 * @returns {string[]}
 */
export function collectToolNames(body) {
    const names = [];
    for (const tool of body?.tools || []) {
        if (tool?.name) names.push(String(tool.name));
    }
    for (const message of body?.messages || []) {
        if (!Array.isArray(message?.content)) continue;
        for (const block of message.content) {
            if (block?.type === 'tool_use' && block.name) names.push(String(block.name));
        }
    }
    return names;
}

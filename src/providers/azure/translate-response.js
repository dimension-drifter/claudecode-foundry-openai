/**
 * Azure Chat Completions responses and stream chunks -> Anthropic events.
 * Thinking blocks are never synthesized.
 */

import crypto from 'crypto';
import { anthropicError } from './errors.js';
import { reasoningItemsFromOutput, traceFromOutput } from './reasoning-trace.js';

export const PREAMBLE_SIGNATURE = 'preamble';

/**
 * Foundry swaps a filtered prompt or reply for "I'm sorry, but I cannot
 * assist with that request." and marks the response incomplete. That
 * sentence is not the model's answer, so it must not enter the chat.
 * @param {object|undefined} response Responses API body
 * @returns {object|null} Anthropic error body
 */
export function contentFilterError(response) {
    if (response?.incomplete_details?.reason !== 'content_filter') return null;
    const hits = [];
    for (const filter of response.content_filters || []) {
        const source = filter?.source_type === 'prompt' ? 'prompt' : 'reply';
        for (const [name, result] of Object.entries(filter?.content_filter_results || {})) {
            if (result?.filtered) hits.push(`${name} (${source}, ${result.severity || 'detected'})`);
        }
    }
    return anthropicError(
        'invalid_request_error',
        `Azure content filter blocked this request: ${hits.join(', ') || 'no category given'}. Raise the deployment's content filter threshold in Foundry, or rephrase.`
    );
}

/**
 * @param {object|undefined} usage
 */
export function mapUsage(usage) {
    const prompt = count(usage?.prompt_tokens ?? usage?.input_tokens);
    const output = count(usage?.completion_tokens ?? usage?.output_tokens);
    const inDetails = usage?.prompt_tokens_details || usage?.input_tokens_details || {};
    const outDetails = usage?.completion_tokens_details || usage?.output_tokens_details || {};
    const cached = Math.min(count(inDetails.cached_tokens), prompt);
    const write = Math.min(
        count(inDetails.cache_write_tokens ?? usage?.cache_write_tokens),
        Math.max(0, prompt - cached)
    );
    const fresh = Math.max(0, prompt - cached - write);
    const reasoning = Math.min(count(outDetails.reasoning_tokens), output);
    const total = usage?.total_tokens != null ? count(usage.total_tokens) : prompt + output;
    return {
        input_tokens: fresh,
        output_tokens: output,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: write,
        total_tokens: total,
        prompt_tokens: prompt,
        reasoning_tokens: reasoning
    };
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function count(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
}

/**
 * @param {string|null|undefined} reason
 * @returns {string}
 */
export function mapFinishReason(reason) {
    if (reason === 'length') return 'max_tokens';
    if (reason === 'tool_calls') return 'tool_use';
    return 'end_turn';
}

/**
 * @param {object} body Azure chat completion JSON
 * @param {{ model: string, restoreName: (name: string) => string }} ctx
 * @returns {{ anthropic: object, totalTokens: number }}
 */
export function translateChatResponse(body, ctx) {
    const choice = body?.choices?.[0] || {};
    const message = choice.message || {};
    const content = [];
    // reasoning_content and reasoning tokens stay out of the Anthropic message.
    // Azure does not return Claude thinking text on Chat Completions.
    const text = messageText(message);
    if (text) content.push({ type: 'text', text });
    if (typeof message.refusal === 'string' && message.refusal) {
        content.push({ type: 'text', text: message.refusal });
    }

    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const call of toolCalls) {
        content.push(toolUseBlock(call, ctx.restoreName));
    }
    if (content.length === 0) content.push({ type: 'text', text: '' });

    const usage = mapUsage(body?.usage);
    return {
        totalTokens: usage.total_tokens,
        meters: usage,
        anthropic: {
            id: `msg_${crypto.randomBytes(16).toString('hex')}`,
            type: 'message',
            role: 'assistant',
            content,
            model: ctx.model,
            stop_reason: toolCalls.length > 0 ? 'tool_use' : mapFinishReason(choice.finish_reason),
            stop_sequence: null,
            usage: publicUsage(usage)
        }
    };
}

/**
 * @param {AsyncIterable<object>} chunks
 * @param {{ model: string, restoreName: (name: string) => string, usageBox?: { total: number } }} ctx
 */
export async function* chatChunksToAnthropicEvents(chunks, ctx) {
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
    let started = false;
    let blockIndex = -1;
    let textOpen = false;
    let usage = mapUsage(null);
    let stopReason = null;
    /** @type {Map<number, { id: string, name: string, fragments: string[] }>} */
    const tools = new Map();
    let trailingText = '';

    const openMessage = function* () {
        if (started) return;
        started = true;
        yield {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: ctx.model,
                stop_reason: null,
                stop_sequence: null,
                usage: publicUsage(mapUsage(null))
            }
        };
    };

    for await (const chunk of chunks) {
        if (chunk?.usage) {
            usage = mapUsage(chunk.usage);
            assignUsageBox(ctx.usageBox, usage);
        }
        const choice = chunk?.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
        const delta = choice.delta || {};

        if (typeof delta.content === 'string' && delta.content !== '') {
            if (tools.size === 0) {
                yield* openMessage();
                if (!textOpen) {
                    blockIndex += 1;
                    textOpen = true;
                    yield {
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: { type: 'text', text: '' }
                    };
                }
                yield {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: delta.content }
                };
            } else {
                trailingText += delta.content;
            }
        }

        if (Array.isArray(delta.tool_calls)) {
            if (textOpen) {
                yield { type: 'content_block_stop', index: blockIndex };
                textOpen = false;
            }
            for (const call of delta.tool_calls) {
                const index = call.index ?? 0;
                let state = tools.get(index);
                if (!state) {
                    state = {
                        id: call.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
                        name: '',
                        fragments: []
                    };
                    tools.set(index, state);
                }
                if (call.id) state.id = call.id;
                if (call.function?.name) state.name = call.function.name;
                if (typeof call.function?.arguments === 'string' && call.function.arguments !== '') {
                    state.fragments.push(call.function.arguments);
                }
            }
        }
    }

    const ordered = [...tools.keys()].sort((a, b) => a - b);
    for (const index of ordered) {
        const state = tools.get(index);
        yield* openMessage();
        blockIndex += 1;
        yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
                type: 'tool_use',
                id: state.id,
                name: ctx.restoreName(state.name || 'tool'),
                input: {}
            }
        };
        const fragments = state.fragments.length > 0 ? state.fragments : ['{}'];
        for (const fragment of fragments) {
            yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: fragment }
            };
        }
        yield { type: 'content_block_stop', index: blockIndex };
    }

    if (trailingText) {
        yield* openMessage();
        blockIndex += 1;
        yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
        };
        yield {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: trailingText }
        };
        yield { type: 'content_block_stop', index: blockIndex };
    }

    if (!started) {
        yield* openMessage();
        blockIndex += 1;
        yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
        };
        yield { type: 'content_block_stop', index: blockIndex };
    } else if (textOpen) {
        yield { type: 'content_block_stop', index: blockIndex };
    }

    if (tools.size > 0) stopReason = 'tool_use';

    yield {
        type: 'message_delta',
        delta: { stop_reason: stopReason || 'end_turn', stop_sequence: null },
        usage: publicUsage(usage)
    };
    yield { type: 'message_stop' };
}

/**
 * @param {object} message
 * @returns {string}
 */
function messageText(message) {
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) return '';
    return message.content
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .filter((text) => text !== '')
        .join('');
}

/**
 * @param {object} call
 * @param {(name: string) => string} restoreName
 */
function toolUseBlock(call, restoreName) {
    let input = {};
    const raw = call.function?.arguments;
    if (typeof raw === 'string' && raw) {
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
        } catch {
            input = {};
        }
    }
    return {
        type: 'tool_use',
        id: call.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
        name: restoreName(call.function?.name || 'tool'),
        input
    };
}

/**
 * @param {ReturnType<typeof mapUsage>} usage
 */
function publicUsage(usage) {
    return {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens
    };
}

/**
 * @param {object} body Azure Responses API JSON
 * @param {{ model: string, restoreName: (name: string) => string }} ctx
 * @returns {{ anthropic: object, totalTokens: number }}
 */
export function translateResponsesBody(body, ctx) {
    const content = [];
    const tools = [];
    let visible = '';
    for (const item of body?.output || []) {
        if (item?.type === 'reasoning') continue;
        if (item?.type === 'message') {
            visible += (item.content || []).map((part) => part?.text || '').join('');
        } else if (item?.type === 'function_call') {
            tools.push(responseToolUse(item, ctx.restoreName));
        }
    }
    if (tools.length > 0 && visible.trim()) {
        content.push({ type: 'thinking', thinking: visible.trim(), signature: PREAMBLE_SIGNATURE });
    } else if (visible) {
        content.push({ type: 'text', text: visible });
    }
    content.push(...tools);
    const hasTool = tools.length > 0;
    if (content.length === 0) content.push({ type: 'text', text: '' });
    const usage = mapUsage(body?.usage);
    return {
        totalTokens: usage.total_tokens,
        meters: usage,
        anthropic: {
            id: `msg_${crypto.randomBytes(16).toString('hex')}`,
            type: 'message',
            role: 'assistant',
            content,
            model: ctx.model,
            stop_reason: hasTool ? 'tool_use' : 'end_turn',
            stop_sequence: null,
            usage: publicUsage(usage)
        }
    };
}

/**
 * @param {AsyncIterable<object>} chunks
 * @param {{ model: string, restoreName: (name: string) => string, usageBox?: object }} ctx
 */
export async function* responsesEventsToAnthropic(chunks, ctx) {
    const messageId = `msg_${crypto.randomBytes(16).toString('hex')}`;
    let started = false;
    let blockIndex = -1;
    let buffered = '';
    let usage = mapUsage(null);
    /** @type {Map<string, { id: string, name: string, fragments: string[] }>} */
    const tools = new Map();
    /** @type {object[]|null} */
    let finalOutput = null;
    let finalResponse = null;
    /** @type {object[]} */
    const doneItems = [];
    let traced = false;

    const keepTrace = (output) => {
        if (traced) return;
        const trace = traceFromOutput(output);
        const items = reasoningItemsFromOutput(output);
        if (!trace && !items.length) return;
        traced = true;
        try {
            if (trace) ctx.onTrace?.(trace);
            if (items.length) ctx.onItems?.(items);
        } catch {
            // A cache write failure leaves the next turn on the transcript path.
        }
    };

    const openMessage = function* () {
        if (started) return;
        started = true;
        yield {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: ctx.model,
                stop_reason: null,
                stop_sequence: null,
                usage: publicUsage(mapUsage(null))
            }
        };
    };

    for await (const chunk of chunks) {
        if (chunk?.response?.usage) {
            usage = mapUsage(chunk.response.usage);
            assignUsageBox(ctx.usageBox, usage);
        }
        if (chunk?.type === 'response.output_text.delta' && chunk.delta) {
            buffered += chunk.delta;
        }
        if (chunk?.type === 'response.output_item.added' && chunk.item?.type === 'function_call') {
            const key = String(chunk.output_index ?? chunk.item.id ?? tools.size);
            tools.set(key, {
                id: chunk.item.call_id || chunk.item.id || `toolu_${crypto.randomBytes(12).toString('hex')}`,
                name: chunk.item.name || '',
                fragments: chunk.item.arguments ? [chunk.item.arguments] : []
            });
        }
        if (chunk?.type === 'response.function_call_arguments.delta' && chunk.delta) {
            const key = String(chunk.output_index ?? chunk.item_id ?? '');
            const state = tools.get(key) || [...tools.values()].at(-1);
            if (state) state.fragments.push(chunk.delta);
        }
        if (chunk?.type === 'response.output_item.done' && chunk.item) {
            const index = Number(chunk.output_index);
            if (Number.isInteger(index) && index >= 0) doneItems[index] = chunk.item;
            else doneItems.push(chunk.item);
        }
        if (chunk?.type === 'response.completed' || chunk?.type === 'response.incomplete') {
            finalResponse = chunk.response;
            if (Array.isArray(chunk.response?.output)) {
                finalOutput = chunk.response.output;
                keepTrace(finalOutput);
            }
        }
    }
    if (!traced) keepTrace(finalOutput || doneItems.filter(Boolean));

    const blocked = contentFilterError(finalResponse);
    if (blocked) {
        yield blocked;
        return;
    }

    if (buffered.trim()) {
        yield* openMessage();
        blockIndex += 1;
        if (tools.size > 0) {
            yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'thinking', thinking: '' }
            };
            yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'thinking_delta', thinking: buffered.trim() }
            };
            yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'signature_delta', signature: PREAMBLE_SIGNATURE }
            };
        } else {
            yield {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' }
            };
            yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: buffered }
            };
        }
        yield { type: 'content_block_stop', index: blockIndex };
    }
    for (const state of tools.values()) {
        yield* openMessage();
        blockIndex += 1;
        yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
                type: 'tool_use',
                id: state.id,
                name: ctx.restoreName(state.name || 'tool'),
                input: {}
            }
        };
        const fragments = state.fragments.length > 0 ? state.fragments : ['{}'];
        for (const fragment of fragments) {
            yield {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: fragment }
            };
        }
        yield { type: 'content_block_stop', index: blockIndex };
    }
    if (!started) {
        yield* openMessage();
        blockIndex += 1;
        yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' }
        };
        yield { type: 'content_block_stop', index: blockIndex };
    }
    yield {
        type: 'message_delta',
        delta: { stop_reason: tools.size > 0 ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: publicUsage(usage)
    };
    yield { type: 'message_stop' };
}

/**
 * @param {object} item
 * @param {(name: string) => string} restoreName
 */
function responseToolUse(item, restoreName) {
    return toolUseBlock({
        id: item.call_id || item.id,
        function: { name: item.name, arguments: item.arguments }
    }, restoreName);
}

/**
 * @param {object|undefined} box
 * @param {ReturnType<typeof mapUsage>} usage
 */
function assignUsageBox(box, usage) {
    if (!box) return;
    box.total = usage.total_tokens;
    box.inputTokens = usage.input_tokens + usage.cache_creation_input_tokens;
    box.freshTokens = usage.input_tokens;
    box.cachedTokens = usage.cache_read_input_tokens;
    box.cacheWriteTokens = usage.cache_creation_input_tokens;
    box.outputTokens = usage.output_tokens;
    box.reasoningTokens = usage.reasoning_tokens;
    box.promptTokens = usage.prompt_tokens;
}

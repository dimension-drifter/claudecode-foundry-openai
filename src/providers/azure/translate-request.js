/**
 * Anthropic Messages request -> Azure Chat Completions request.
 * Thinking blocks are removed. Anthropic server tools are omitted so Claude
 * Code's own tools (Read, Bash, Edit, and the rest) still run.
 */

import crypto from 'crypto';
import { sanitizeSchema } from './schema.js';

/**
 * Versioned Anthropic server tools have a type other than custom/function.
 * Claude Code client tools omit type or use "custom" and include input_schema.
 * @param {object} tool
 * @returns {boolean}
 */
export function isServerTool(tool) {
    const type = typeof tool?.type === 'string' ? tool.type : '';
    if (!type || type === 'custom' || type === 'function') return false;
    return true;
}

/**
 * @param {number|undefined} requested
 * @param {number} maxOutputTokens
 * @returns {number}
 */
export function capOutputTokens(requested, maxOutputTokens) {
    const cap = Math.max(1, Math.floor(maxOutputTokens) || 1);
    const asked = Number.isFinite(requested) ? Math.floor(requested) : cap;
    return Math.min(Math.max(asked, 1), cap);
}

/**
 * @param {object} body
 * @param {{ deployment: string, maxCompletionTokens: number, nameMap: { shorten: Function } }} ctx
 */
export function translateAnthropicRequest(body, ctx) {
    const omittedServerTools = [];
    const keptTools = [];
    for (const tool of body.tools || []) {
        if (!tool?.name) continue;
        if (isServerTool(tool)) {
            omittedServerTools.push(String(tool.name));
            continue;
        }
        keptTools.push(tool);
    }
    const omittedNames = new Set(omittedServerTools);
    const messages = [];
    const system = systemText(body.system);
    if (system) messages.push({ role: 'system', content: system });
    messages.push(...convertMessages(body.messages || [], ctx.nameMap, omittedNames));

    if (!messages.some((message) => message.role === 'user' || message.role === 'tool')) {
        throw new Error('messages must include a user message');
    }

    const payload = {
        model: ctx.deployment,
        messages,
        max_completion_tokens: ctx.maxCompletionTokens
    };

    if (body.stream) {
        payload.stream = true;
        payload.stream_options = { include_usage: true };
    }

    if (keptTools.length > 0) {
        payload.tools = keptTools.map((tool) => ({
            type: 'function',
            function: {
                name: ctx.nameMap.shorten(String(tool.name)),
                description: typeof tool.description === 'string' ? tool.description : '',
                parameters: sanitizeSchema(tool.input_schema || tool.parameters || { type: 'object', properties: {} })
            }
        }));
        const choice = mapToolChoice(body.tool_choice, ctx.nameMap, omittedNames);
        payload.tool_choice = choice.choice;
        payload.parallel_tool_calls = choice.parallel;
    }

    if (Array.isArray(body.stop_sequences) && supportsStopParameter(ctx.deployment)) {
        const stop = body.stop_sequences.filter((item) => typeof item === 'string' && item.length > 0).slice(0, 4);
        if (stop.length > 0) payload.stop = stop;
    }

    const effort = selectReasoningEffort(ctx.deployment, body, keptTools.length > 0, ctx.reasoningEffort);
    const useResponses = usesResponsesApi(ctx.deployment, keptTools.length > 0);
    if (useResponses) {
        // Foundry counts reasoning inside max_output_tokens. Claude Code's
        // max_tokens is only the visible answer, so add the thinking budget.
        payload.max_completion_tokens = responsesOutputLimit(
            ctx.maxCompletionTokens,
            body.thinking,
            ctx.outputCeiling || ctx.maxCompletionTokens
        );
        return {
            payload: chatPayloadToResponses(payload, effort, ctx.reasoningLookup),
            omittedServerTools,
            api: 'responses'
        };
    }
    if (effort) payload.reasoning_effort = effort;

    return { payload, omittedServerTools, api: 'chat' };
}

/**
 * GPT-6 Chat Completions rejects function tools unless reasoning is off.
 * The Responses API is the path that keeps reasoning and Claude Code tools together.
 * @param {string} deployment
 * @param {number} toolCount
 * @returns {boolean}
 */
export function usesResponsesApi(deployment, toolCount) {
    return toolCount > 0 && String(deployment || '').toLowerCase().includes('gpt-6');
}

/**
 * GPT-6 rejects `stop` on Chat Completions. Claude Code's auto-mode safety
 * check is a non-streaming call that includes stop sequences. Forwarding
 * them makes that check fail, so skills and agents never start.
 * @param {string} deployment
 * @returns {boolean}
 */
export function supportsStopParameter(deployment) {
    const name = String(deployment || '').toLowerCase();
    if (name.includes('gpt-6') || name.includes('gpt-5')) return false;
    if (/(^|[^a-z])o[134]([^a-z]|$)/.test(name)) return false;
    return true;
}

/**
 * Foundry's output cap includes reasoning tokens. Claude Code budgets those
 * separately, as thinking.budget_tokens. Without the extra room the visible
 * answer is whatever fits after the scratchpad.
 * @param {number} visible
 * @param {object|undefined} thinking
 * @param {number} ceiling
 * @returns {number}
 */
export function responsesOutputLimit(visible, thinking, ceiling) {
    const cap = Math.max(1, Math.floor(ceiling) || 1);
    const asked = Math.max(1, Math.floor(visible) || 1);
    const type = thinking?.type;
    let reserve = 16000;
    if (type === 'disabled' || type === 'off') reserve = 0;
    else {
        const budget = Number(thinking?.budget_tokens);
        if (Number.isFinite(budget) && budget > 0) reserve = Math.floor(budget);
    }
    return Math.min(cap, asked + reserve);
}

/** Prior-turn scratchpads kept for all_turns, in characters of encrypted text. */
const PRIOR_ENCRYPTED_CHARS = 80000;

/**
 * Tool results are role "tool", so the last role "user" text is the question
 * the current tool loop is still answering.
 * @param {object[]} messages
 * @returns {number}
 */
function lastUserTextIndex(messages) {
    let last = -1;
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message?.role === 'user' && hasUserText(message.content)) last = index;
    }
    return last;
}

/**
 * @param {unknown} content
 * @returns {boolean}
 */
function hasUserText(content) {
    if (typeof content === 'string') return content.trim() !== '';
    if (!Array.isArray(content)) return false;
    return content.some((part) => {
        if (typeof part === 'string') return part.trim() !== '';
        if (part?.type === 'text' || part?.type === 'input_text') return String(part.text || '').trim() !== '';
        return false;
    });
}

/**
 * @param {object} message
 * @param {(callIds: string[]) => object|null} [lookup]
 * @returns {object|null}
 */
function assistantTrace(message, lookup) {
    if (!lookup || !Array.isArray(message?.tool_calls)) return null;
    const callIds = message.tool_calls.map((call) => call.id).filter(Boolean);
    if (!callIds.length) return null;
    return lookup(callIds);
}

/**
 * @param {object|null} trace
 * @returns {number}
 */
function encryptedSize(trace) {
    return (trace?.items || []).reduce((sum, item) => sum + String(item.encrypted_content || '').length, 0);
}

/**
 * Current tool loop is always replayed. Older scratchpads are replayed newest
 * first until the character budget, so a follow-up question still has the plan
 * and a long session does not resend every prior turn.
 * @param {object[]} messages
 * @param {(callIds: string[]) => object|null} [lookup]
 * @returns {Set<number>}
 */
function tracesToReplay(messages, lookup) {
    const selected = new Set();
    if (!lookup) return selected;
    const lastUser = lastUserTextIndex(messages);
    for (let index = lastUser + 1; index < messages.length; index += 1) {
        if (assistantTrace(messages[index], lookup)) selected.add(index);
    }
    let used = 0;
    for (let index = lastUser - 1; index >= 0; index -= 1) {
        const trace = assistantTrace(messages[index], lookup);
        if (!trace) continue;
        const size = encryptedSize(trace);
        if (used > 0 && used + size > PRIOR_ENCRYPTED_CHARS) break;
        selected.add(index);
        used += size;
        if (used >= PRIOR_ENCRYPTED_CHARS) break;
    }
    return selected;
}

/**
 * @param {object} chat Chat Completions payload
 * @param {string|undefined} effort
 * @param {(callIds: string[]) => object|null} [lookup]
 * @returns {object}
 */
export function chatPayloadToResponses(chat, effort, lookup) {
    const instructions = [];
    const input = [];
    const messages = chat.messages || [];
    const replay = tracesToReplay(messages, lookup);
    for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.role === 'system') {
            if (typeof message.content === 'string' && message.content) instructions.push(message.content);
            continue;
        }
        if (message.role === 'tool') {
            input.push({
                type: 'function_call_output',
                call_id: message.tool_call_id,
                output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
            });
            continue;
        }
        if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
            const trace = replay.has(index) ? assistantTrace(message, lookup) : null;
            const text = message.content ? { role: 'assistant', content: message.content } : null;
            const calls = message.tool_calls.map((call) => {
                const item = {
                    type: 'function_call',
                    call_id: call.id,
                    name: call.function?.name,
                    arguments: call.function?.arguments || '{}'
                };
                const itemId = trace?.callItemIds?.[call.id];
                if (itemId) item.id = itemId;
                return item;
            });
            if (trace?.lead === 'text' && text) input.push(text);
            if (trace?.items) input.push(...trace.items);
            if (trace?.lead !== 'text' && text) input.push(text);
            input.push(...calls);
            continue;
        }
        input.push({
            role: message.role,
            content: responsesContent(message.content)
        });
    }

    const payload = {
        model: chat.model,
        input,
        max_output_tokens: chat.max_completion_tokens
    };
    if (instructions.length > 0) payload.instructions = instructions.join('\n\n');
    if (Array.isArray(chat.tools) && chat.tools.length > 0) {
        payload.tools = chat.tools.map((tool) => ({
            type: 'function',
            name: tool.function.name,
            description: tool.function.description || '',
            parameters: tool.function.parameters
        }));
        if (chat.tool_choice) payload.tool_choice = responsesToolChoice(chat.tool_choice);
    }
    if (chat.stream) payload.stream = true;
    // Stateless, so Foundry returns encrypted reasoning. all_turns renders the
    // scratchpads this request replays, including the previous question.
    payload.store = false;
    payload.include = ['reasoning.encrypted_content'];
    payload.reasoning = { context: 'all_turns' };
    if (effort) payload.reasoning.effort = effort;
    return payload;
}

/**
 * @param {unknown} content
 * @returns {string|object[]}
 */
function responsesContent(content) {
    if (typeof content === 'string' || content == null) return content || '';
    if (!Array.isArray(content)) return String(content);
    return content.map((part) => {
        if (part?.type === 'image_url') {
            return { type: 'input_image', image_url: part.image_url?.url || '' };
        }
        return { type: 'input_text', text: part?.text || '' };
    });
}

/**
 * @param {unknown} choice
 */
function responsesToolChoice(choice) {
    if (choice && typeof choice === 'object' && choice.type === 'function') {
        return { type: 'function', name: choice.function?.name };
    }
    return choice;
}

/**
 * Chat Completions does not return Claude thinking text. GPT-6 still reasons
 * internally when reasoning_effort is set. gpt-5.6 rejects tools unless effort
 * is none. Other deployments omit the field so older models are not rejected.
 * @param {string} deployment
 * @param {object} body
 * @param {boolean} hasTools
 * @param {string} [explicit]
 * @returns {string|undefined}
 */
export function selectReasoningEffort(deployment, body, hasTools, explicit) {
    if (explicit) return explicit;
    const named = String(body?.effort || body?.effort_level || body?.output_config?.effort || '').toLowerCase();
    if (['none', 'low', 'medium', 'high', 'xhigh'].includes(named)) return named;
    const name = String(deployment || '').toLowerCase();
    const reasoningModel = name.includes('gpt-6') || name.includes('gpt-5') || /(^|[^a-z])o[134]([^a-z]|$)/.test(name);
    if (!reasoningModel) return undefined;
    if (hasTools && name.includes('gpt-5.6')) return 'none';
    const thinking = body?.thinking;
    if (thinking && (thinking.type === 'disabled' || thinking.type === 'off')) return 'none';
    if (!thinking) return undefined;
    const budget = Number(thinking.budget_tokens);
    if (Number.isFinite(budget) && budget > 0 && budget < 8000) return 'low';
    if (Number.isFinite(budget) && budget >= 32000) return 'high';
    return 'medium';
}

/**
 * @param {unknown} system
 * @returns {string}
 */
function systemText(system) {
    if (!system) return '';
    if (typeof system === 'string') return system;
    if (!Array.isArray(system)) return '';
    return system
        .filter((block) => block && typeof block.text === 'string' && block.type !== 'thinking' && block.type !== 'redacted_thinking')
        .map((block) => block.text)
        .filter((text) => text !== '')
        .join('\n\n');
}

/**
 * @param {unknown} content
 * @returns {object[]}
 */
function asBlocks(content) {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (Array.isArray(content)) return content.filter(Boolean);
    if (content == null) return [];
    return [{ type: 'text', text: String(content) }];
}

/**
 * @param {object} block
 * @returns {object}
 */
function imagePart(block) {
    const source = block.source || {};
    if (source.type === 'base64' && typeof source.data === 'string' && typeof source.media_type === 'string') {
        return {
            type: 'image_url',
            image_url: { url: `data:${source.media_type};base64,${source.data}` }
        };
    }
    if (source.type === 'url' && typeof source.url === 'string' && source.url.startsWith('https://')) {
        return { type: 'image_url', image_url: { url: source.url } };
    }
    return { type: 'text', text: '[Image omitted]' };
}

/**
 * @param {object} block
 * @returns {object[]}
 */
function contentParts(block) {
    if (!block || typeof block !== 'object') return [];
    if (block.type === 'thinking' || block.type === 'redacted_thinking') return [];
    if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text !== '') return [{ type: 'text', text: block.text }];
        return [];
    }
    if (block.type === 'image') return [imagePart(block)];
    if (block.type === 'document') {
        const label = block.title || block.source?.media_type || 'document';
        return [{ type: 'text', text: `[Attached document omitted (${label})]` }];
    }
    return [];
}

/**
 * @param {object[]} parts
 * @returns {string|object[]|null}
 */
function collapseParts(parts) {
    if (!parts || parts.length === 0) return null;
    if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('\n');
    return parts;
}

/**
 * @param {object} block
 * @returns {{ text: string, images: object[] }}
 */
function toolResultPieces(block) {
    const texts = [];
    const images = [];
    const content = block.content;
    if (typeof content === 'string') {
        texts.push(content);
    } else if (Array.isArray(content)) {
        for (const part of content) {
            if (!part) continue;
            if (typeof part === 'string') {
                texts.push(part);
            } else if (part.type === 'text') {
                texts.push(part.text || '');
            } else if (part.type === 'image') {
                const image = imagePart(part);
                if (image.type === 'image_url') images.push(image);
                else texts.push(image.text);
            }
        }
    } else if (content != null) {
        texts.push(JSON.stringify(content));
    }

    let text = texts.filter((item) => item !== '').join('\n');
    if (block.is_error) text = text ? `Error: ${text}` : 'Error';
    if (!text && images.length > 0) text = '[image]';
    return { text, images };
}

/**
 * @param {object[]} anthropicMessages
 * @param {{ shorten: Function }} nameMap
 * @param {Set<string>} omittedNames
 * @returns {object[]}
 */
function convertMessages(anthropicMessages, nameMap, omittedNames) {
    const out = [];
    const omittedIds = new Set();

    for (const message of anthropicMessages) {
        const role = message?.role;
        const blocks = asBlocks(message?.content);

        if (role === 'assistant') {
            const textParts = [];
            const images = [];
            const toolCalls = [];
            for (const block of blocks) {
                if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
                if (block.type === 'tool_use') {
                    const name = String(block.name || 'tool');
                    if (omittedNames.has(name)) {
                        if (block.id) omittedIds.add(block.id);
                        textParts.push(`[Server tool ${name} is not available on this proxy]`);
                        continue;
                    }
                    let args = block.input ?? {};
                    if (typeof args !== 'string') args = JSON.stringify(args);
                    toolCalls.push({
                        id: block.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                        type: 'function',
                        function: {
                            name: nameMap.shorten(name),
                            arguments: args
                        }
                    });
                    continue;
                }
                for (const part of contentParts(block)) {
                    if (part.type === 'image_url') images.push(part);
                    else if (part.type === 'text') textParts.push(part.text);
                }
            }
            const text = textParts.join('\n');
            if (!text && toolCalls.length === 0 && images.length === 0) continue;
            const converted = { role: 'assistant' };
            if (images.length > 0) {
                const content = [];
                if (text) content.push({ type: 'text', text });
                content.push(...images);
                converted.content = content;
            } else if (text) {
                converted.content = text;
            } else if (toolCalls.length > 0) {
                converted.content = null;
            }
            if (toolCalls.length > 0) converted.tool_calls = toolCalls;
            out.push(converted);
            continue;
        }

        const toolBlocks = blocks.filter((block) => block.type === 'tool_result');
        const otherBlocks = blocks.filter((block) => block.type !== 'tool_result');
        for (const block of toolBlocks) {
            const pieces = toolResultPieces(block);
            if (block.tool_use_id && omittedIds.has(block.tool_use_id)) {
                out.push({
                    role: 'user',
                    content: pieces.text || '[Server tool result omitted]'
                });
                continue;
            }
            out.push({
                role: 'tool',
                tool_call_id: block.tool_use_id || 'unknown',
                content: pieces.text || ''
            });
            if (pieces.images.length > 0) {
                out.push({ role: 'user', content: pieces.images });
            }
        }

        const parts = [];
        for (const block of otherBlocks) parts.push(...contentParts(block));
        const collapsed = collapseParts(parts);
        if (collapsed != null && collapsed !== '') {
            out.push({ role: 'user', content: collapsed });
        }
    }

    return out;
}

/**
 * @param {unknown} choice
 * @param {{ shorten: Function }} nameMap
 * @param {Set<string>} omittedNames
 * @returns {{ choice: unknown, parallel: boolean }}
 */
function mapToolChoice(choice, nameMap, omittedNames) {
    const disableParallel = Boolean(choice && typeof choice === 'object' && choice.disable_parallel_tool_use);
    if (!choice || choice === 'auto' || choice?.type === 'auto') {
        return { choice: 'auto', parallel: !disableParallel };
    }
    if (choice === 'none' || choice?.type === 'none') {
        return { choice: 'none', parallel: false };
    }
    if (choice === 'any' || choice?.type === 'any') {
        return { choice: 'required', parallel: !disableParallel };
    }
    if (choice?.type === 'tool' && choice.name) {
        if (omittedNames.has(choice.name)) {
            throw new Error(`Tool "${choice.name}" is an Anthropic server tool and cannot run on Azure`);
        }
        return {
            choice: { type: 'function', function: { name: nameMap.shorten(String(choice.name)) } },
            parallel: false
        };
    }
    return { choice: 'auto', parallel: !disableParallel };
}

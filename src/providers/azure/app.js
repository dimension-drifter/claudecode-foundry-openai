/**
 * Express app for the Azure backend. It does not mount the Google WebUI,
 * account routes, or CORS.
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { RequestActivity } from './activity.js';
import { UsageLedger } from './ledger.js';
import { createAzureClient } from './client.js';
import { anthropicError, isAbortError, readAzureError } from './errors.js';
import { redactSecrets, safeEqualString } from './redact.js';
import { resolveSettings, resolveDeployment, listModelIds } from './settings.js';
import { loadRouting, publicRouting, saveRouting } from './routing.js';
import { SpendGuard } from './spend-guard.js';
import { readSseJson } from './sse.js';
import { buildNameMap, collectToolNames } from './tool-names.js';
import { capOutputTokens, translateAnthropicRequest } from './translate-request.js';
import { createReasoningCache, traceFromOutput } from './reasoning-trace.js';
import { chatChunksToAnthropicEvents, responsesEventsToAnthropic, translateChatResponse, translateResponsesBody } from './translate-response.js';

/**
 * @param {object} options
 * @returns {import('express').Express}
 */
export function createAzureApp(options = {}) {
    const settings = options.settings || resolveSettings({ ...options, requireSecrets: options.requireSecrets !== false });
    loadRouting(settings);
    const secrets = [settings.azureApiKey, settings.proxyApiKey].filter((value) => typeof value === 'string' && value.length >= 8);
    const log = options.log || {
        info() {},
        warn() {},
        error() {}
    };
    const spend = options.spend || new SpendGuard({
        filePath: path.join(settings.dataDir, 'spend.json'),
        ceiling: settings.dailyTokenCeiling
    });
    const activity = options.activity || new RequestActivity(path.join(settings.dataDir, 'requests.json'));
    const ledger = options.ledger || new UsageLedger(path.join(settings.dataDir, 'ledger.json'));
    if (!options.ledger) ledger.backfill(activity.snapshot());
    const dashboardHtml = fs.readFileSync(new URL('./dashboard.html', import.meta.url), 'utf8');
    const reasoningCache = options.reasoningCache || createReasoningCache(path.join(settings.dataDir, 'reasoning'));
    const client = options.client || createAzureClient({
        endpoint: settings.endpoint,
        apiKey: settings.azureApiKey,
        allowHosts: settings.allowHosts,
        allowHttpLoopback: settings.allowHttpLoopback === true,
        fetchImpl: options.fetchImpl
    });

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '50mb' }));

    // Claude Code posts heartbeats to the base URL. They never call Azure.
    app.post('/', (_req, res) => {
        res.json({ status: 'ok' });
    });
    app.post('/api/event_logging/batch', (_req, res) => {
        res.json({ status: 'ok' });
    });

    const requireProxyAuth = (req, res, next) => {
        if (!settings.proxyApiKey) return next();
        const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
        const xApiKey = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '';
        let provided = '';
        if (header.startsWith('Bearer ')) provided = header.slice(7);
        else if (xApiKey) provided = xApiKey;
        if (!safeEqualString(provided, settings.proxyApiKey)) {
            return res.status(401).json(anthropicError('authentication_error', 'Invalid or missing API key'));
        }
        return next();
    };

    app.get(['/', '/usage'], (_req, res) => {
        res.type('html').send(dashboardHtml);
    });
    app.get('/api/usage', (_req, res) => {
        const today = spend.snapshot();
        const deployments = [...new Set([
            settings.defaultDeployment,
            settings.opus,
            settings.sonnet,
            settings.haiku,
            settings.fable,
            ...(settings.models || [])
        ].filter(Boolean))];
        const payload = {
            provider: 'azure',
            azureKeyLoaded: Boolean(settings.azureApiKey),
            deployments,
            today,
            requests: activity.snapshot(),
            cost: ledger.summary(today.day),
            routing: publicRouting(settings)
        };
        res.type('json').send(redactSecrets(JSON.stringify(payload), secrets));
    });
    app.post('/api/routing', (req, res) => {
        try {
            const routing = saveRouting(settings, req.body?.routes, options.envPath);
            res.json({
                ok: true,
                routing,
                notice: 'Restart Claude Code. This proxy is already using the new mapping. The open Claude Code session keeps the previous choice until you restart it.'
            });
        } catch (error) {
            res.status(400).json({ error: error.message || 'Could not save the mapping' });
        }
    });
    app.use('/v1', requireProxyAuth);
    app.use('/health', requireProxyAuth);

    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', provider: 'azure' });
    });

    app.get('/v1/models', (_req, res) => {
        const created = Math.floor(Date.now() / 1000);
        res.json({
            object: 'list',
            data: listModelIds(settings).map((id) => ({
                id,
                object: 'model',
                created,
                owned_by: 'azure'
            }))
        });
    });

    app.post('/v1/messages/count_tokens', (req, res) => {
        const body = req.body || {};
        const raw = JSON.stringify({
            system: body.system || '',
            messages: body.messages || [],
            tools: body.tools || []
        });
        res.json({ input_tokens: Math.max(1, Math.ceil(raw.length / 4)) });
    });

    app.post('/v1/messages', async (req, res) => {
        try {
            await handleMessages(req, res, { settings, secrets, log, spend, client, activity, ledger, reasoningCache });
        } catch (error) {
            log.error('[azure] message handler failed', redactSecrets(error?.message || 'error', secrets));
            if (!res.headersSent && !res.writableEnded) {
                res.status(500).json(anthropicError('api_error', 'Internal error'));
            }
        }
    });

    app.use((_req, res) => {
        res.status(404).json(anthropicError('not_found_error', 'Not found'));
    });

    app.use((error, _req, res, _next) => {
        if (res.headersSent) return;
        if (error?.type === 'entity.parse.failed') {
            res.status(400).json(anthropicError('invalid_request_error', 'Request body is not valid JSON'));
            return;
        }
        log.error('[azure] request error', redactSecrets(error?.message || 'error', secrets));
        res.status(500).json(anthropicError('api_error', 'Internal error'));
    });

    return app;
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} ctx
 */
async function handleMessages(req, res, ctx) {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) {
        res.status(400).json(anthropicError('invalid_request_error', 'messages is required and must be an array'));
        return;
    }
    if (body.messages.length === 1 && body.messages[0]?.content === 'count') {
        res.json({});
        return;
    }

    const started = Date.now();
    const outcome = {
        status: 500,
        deployment: '',
        inputTokens: 0,
        freshTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        promptTokens: 0,
        totalTokens: 0,
        stopReason: ''
    };
    let recorded = false;
    const save = async (status) => {
        if (recorded || !ctx.activity) return;
        recorded = true;
        outcome.status = status;
        try {
            const row = await ctx.activity.record({
                model: body.model,
                deployment: outcome.deployment,
                stream: Boolean(body.stream),
                status,
                inputTokens: outcome.inputTokens,
                freshTokens: outcome.freshTokens,
                outputTokens: outcome.outputTokens,
                cachedTokens: outcome.cachedTokens,
                cacheWriteTokens: outcome.cacheWriteTokens,
                reasoningTokens: outcome.reasoningTokens,
                promptTokens: outcome.promptTokens,
                totalTokens: outcome.totalTokens,
                durationMs: Date.now() - started,
                stopReason: outcome.stopReason
            });
            if (ctx.ledger) await ctx.ledger.apply(row);
        } catch {
            // A usage-log failure must not change the Claude Code response.
        }
    };

    let deployment;
    try {
        deployment = resolveDeployment(body.model, ctx.settings);
        outcome.deployment = deployment;
    } catch (error) {
        await save(400);
        res.status(400).json(anthropicError('invalid_request_error', redactSecrets(error.message, ctx.secrets)));
        return;
    }

    const maxCompletionTokens = capOutputTokens(body.max_tokens, ctx.settings.maxOutputTokens);
    const nameMap = buildNameMap(collectToolNames(body));
    let translated;
    try {
        translated = translateAnthropicRequest(body, {
            deployment,
            maxCompletionTokens,
            nameMap,
            reasoningEffort: ctx.settings.reasoningEffort || '',
            outputCeiling: ctx.settings.maxOutputTokens,
            reasoningLookup: (callIds) => ctx.reasoningCache.lookup(callIds)
        });
    } catch (error) {
        await save(400);
        res.status(400).json(anthropicError('invalid_request_error', redactSecrets(error.message, ctx.secrets)));
        return;
    }

    if (translated.omittedServerTools.length > 0) {
        ctx.log.info(`[azure] omitted server tools: ${translated.omittedServerTools.join(', ')}`);
    }
    ctx.log.info(`[azure] ${body.model} -> ${deployment} stream=${Boolean(body.stream)}`);

    let reserved = 0;
    let spent = false;
    const finishSpend = async (total) => {
        if (spent) return;
        spent = true;
        if (total > 0) await ctx.spend.commit(reserved, total);
        else await ctx.spend.cancel(reserved);
    };

    try {
        reserved = await ctx.spend.beforeRequest(maxCompletionTokens);
    } catch (error) {
        if (error?.code === 'CEILING') {
            await save(429);
            res.status(429).json(anthropicError('rate_limit_error', 'Daily token ceiling reached'));
            return;
        }
        ctx.log.error('[azure] spend guard failed', redactSecrets(error?.message || 'error', ctx.secrets));
        await save(500);
        res.status(500).json(anthropicError('api_error', 'Spend guard failed'));
        return;
    }

    const controller = new AbortController();
    const stopIfClientGone = () => {
        if (res.writableFinished) return;
        controller.abort();
    };
    // The request body is already consumed, so req 'close' can mean "body done"
    // rather than "client gone". Watch the socket and the response instead.
    res.on('close', stopIfClientGone);
    if (req.socket) {
        req.socket.setNoDelay(true);
        req.socket.on('close', stopIfClientGone);
        if (req.socket.destroyed) controller.abort();
    }

    try {
        const azureResponse = await ctx.client.complete(translated.payload, {
            signal: controller.signal,
            api: translated.api
        });
        if (!azureResponse.ok) {
            const mapped = await readAzureError(azureResponse, ctx.secrets);
            await finishSpend(0);
            ctx.log.warn(`[azure] upstream ${azureResponse.status}: ${mapped.body.error.message}`);
            await save(mapped.status);
            if (!res.headersSent && !res.writableEnded) {
                res.status(mapped.status).json(mapped.body);
            }
            return;
        }

        if (body.stream) {
            const usageBox = { total: 0 };
            res.status(200);
            res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            if (typeof res.flushHeaders === 'function') res.flushHeaders();

            try {
                for await (const event of (translated.api === 'responses' ? responsesEventsToAnthropic : chatChunksToAnthropicEvents)(readSseJson(azureResponse), {
                    model: String(body.model),
                    restoreName: (name) => nameMap.restore(name),
                    usageBox,
                    onTrace: (trace) => ctx.reasoningCache.save(trace)
                })) {
                    if (res.writableEnded) break;
                    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
                }
            } catch (error) {
                if (!isAbortError(error) && !res.writableEnded) {
                    const message = redactSecrets(error?.message || 'stream failed', ctx.secrets);
                    res.write(`event: error\ndata: ${JSON.stringify(anthropicError('api_error', message))}\n\n`);
                }
            }
            await finishSpend(usageBox.total);
            copyMeters(outcome, usageBox);
            outcome.stopReason = 'end_turn';
            await save(200);
            if (!res.writableEnded) res.end();
            return;
        }

        const text = await azureResponse.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch {
            await finishSpend(0);
            await save(502);
            if (!res.headersSent && !res.writableEnded) {
                res.status(502).json(anthropicError('api_error', 'Azure returned a non-JSON response'));
            }
            return;
        }
        if (translated.api === 'responses') ctx.reasoningCache.save(traceFromOutput(json.output));
        const { anthropic, totalTokens, meters } = (translated.api === 'responses' ? translateResponsesBody : translateChatResponse)(json, {
            model: String(body.model),
            restoreName: (name) => nameMap.restore(name)
        });
        copyMeters(outcome, {
            total: totalTokens,
            inputTokens: meters.input_tokens + meters.cache_creation_input_tokens,
            freshTokens: meters.input_tokens,
            outputTokens: meters.output_tokens,
            cachedTokens: meters.cache_read_input_tokens,
            cacheWriteTokens: meters.cache_creation_input_tokens,
            reasoningTokens: meters.reasoning_tokens,
            promptTokens: meters.prompt_tokens
        });
        outcome.stopReason = anthropic.stop_reason || '';
        await finishSpend(totalTokens);
        await save(200);
        if (!res.writableEnded) res.json(anthropic);
    } catch (error) {
        await finishSpend(0);
        if (isAbortError(error) || res.writableEnded || controller.signal.aborted) {
            await save(499);
            return;
        }
        ctx.log.error('[azure] upstream failed', redactSecrets(error?.message || 'error', ctx.secrets));
        await save(502);
        if (!res.headersSent && !res.writableEnded) {
            res.status(502).json(anthropicError('api_error', redactSecrets(error?.message || 'Upstream request failed', ctx.secrets)));
        }
    } finally {
        res.removeListener('close', stopIfClientGone);
        if (req.socket) req.socket.removeListener('close', stopIfClientGone);
        await save(outcome.status);
    }
}

/**
 * @param {object} outcome
 * @param {object} box
 */
function copyMeters(outcome, box) {
    outcome.totalTokens = box.total || 0;
    outcome.inputTokens = box.inputTokens || 0;
    outcome.freshTokens = box.freshTokens || 0;
    outcome.outputTokens = box.outputTokens || 0;
    outcome.cachedTokens = box.cachedTokens || 0;
    outcome.cacheWriteTokens = box.cacheWriteTokens || 0;
    outcome.reasoningTokens = box.reasoningTokens || 0;
    outcome.promptTokens = box.promptTokens || 0;
}

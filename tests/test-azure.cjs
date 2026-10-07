/**
 * Azure backend tests. They talk to a local mock only.
 * The Azure key below is fake and must never appear in responses, logs, or spend.json.
 */

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const test = require('node:test');

const PROXY_KEY = 'proxy-test-key-0123456789';
const AZURE_KEY = 'azure-test-key-do-not-leak-0123456789';
const ALLOWED_HOST = 'contoso.openai.azure.com';

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'azure-proxy-'));
}

function assertClean(text, label) {
    const value = String(text);
    if (value.includes(AZURE_KEY) || value.includes(PROXY_KEY)) {
        throw new Error(`${label} contains a secret`);
    }
}

function parseSse(text) {
    const events = [];
    for (const block of String(text).split('\n\n')) {
        if (!block.trim()) continue;
        let data = '';
        for (const line of block.split('\n')) {
            if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        events.push(JSON.parse(data));
    }
    return events;
}

function sse(obj) {
    return `data: ${JSON.stringify(obj)}\n\n`;
}

function startMock(handler) {
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
            json = raw ? JSON.parse(raw) : null;
        } catch {
            json = null;
        }
        const record = {
            method: req.method,
            url: req.url,
            headers: req.headers,
            json,
            raw,
            req
        };
        requests.push(record);
        await handler(record, res);
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                requests,
                url: `http://127.0.0.1:${port}/openai/v1`,
                close: () => new Promise((done) => {
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    server.close(done);
                })
            });
        });
    });
}

function startApp(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            resolve({
                port: server.address().port,
                close: () => new Promise((done) => {
                    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
                    server.close(done);
                })
            });
        });
    });
}

function request({ port, method = 'POST', path: reqPath, body, auth = PROXY_KEY, headers = {} }) {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            method,
            path: reqPath,
            headers: {
                ...(payload ? {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length
                } : {}),
                ...(auth == null ? {} : { 'x-api-key': auth }),
                ...headers
            }
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    text: Buffer.concat(chunks).toString('utf8')
                });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function makeHarness(extra = {}) {
    const { createAzureApp } = await import('../src/providers/azure/app.js');
    const dir = tmpDir();
    const logs = [];
    const log = (...args) => logs.push(args.map((arg) => String(arg)).join(' '));
    const mock = await startMock(extra.onRequest || (async (_record, res) => {
        const body = extra.azureBody || {
            choices: [{
                message: { role: 'assistant', content: 'Hello from Azure' },
                finish_reason: 'stop'
            }],
            usage: {
                prompt_tokens: 5,
                completion_tokens: 3,
                total_tokens: 8,
                prompt_tokens_details: { cached_tokens: 2 }
            }
        };
        res.writeHead(extra.azureStatus || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }));
    const app = createAzureApp({
        proxyApiKey: PROXY_KEY,
        azureApiKey: AZURE_KEY,
        endpoint: mock.url,
        allowHttpLoopback: true,
        allowHosts: ['127.0.0.1'],
        deployment: extra.deployment || 'gpt-deploy',
        opus: extra.opus,
        sonnet: extra.sonnet,
        haiku: extra.haiku,
        fable: extra.fable,
        models: extra.models,
        reasoningEffort: extra.reasoningEffort,
        aliases: extra.aliases,
        dataDir: dir,
        maxOutputTokens: extra.maxOutputTokens ?? 1024,
        dailyTokenCeiling: extra.dailyTokenCeiling ?? 100000,
        log: { info: log, warn: log, error: log }
    });
    const proxy = await startApp(app);
    return {
        dir,
        logs,
        mock,
        proxy,
        async close() {
            await proxy.close();
            await mock.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}

function userMessage(text) {
    return {
        model: 'claude-sonnet-4-6',
        max_tokens: 128,
        system: [{ type: 'text', text: 'You are Claude Code', cache_control: { type: 'ephemeral' } }],
        messages: [{
            role: 'user',
            content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
        }]
    };
}

test('plain text maps usage, strips cache_control, and hides the key', async () => {
    const harness = await makeHarness();
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('Hi'), temperature: 1, top_p: 0.9, top_k: 40 }
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers['x-powered-by'], undefined);
        assert.equal(response.headers['access-control-allow-origin'], undefined);
        assertClean(response.text, 'plain text response');
        const json = JSON.parse(response.text);
        assert.equal(json.type, 'message');
        assert.equal(json.role, 'assistant');
        assert.equal(json.model, 'claude-sonnet-4-6');
        assert.equal(json.content[0].text, 'Hello from Azure');
        assert.equal(json.stop_reason, 'end_turn');
        assert.equal(json.usage.input_tokens, 3);
        assert.equal(json.usage.output_tokens, 3);
        assert.equal(json.usage.cache_read_input_tokens, 2);
        assert.equal(json.usage.cache_creation_input_tokens, 0);

        const sent = harness.mock.requests[0];
        assert.equal(sent.url, '/openai/v1/chat/completions');
        assert.equal(sent.headers['api-key'], AZURE_KEY);
        assert.equal(sent.headers.authorization, undefined);
        assert.equal(sent.json.model, 'gpt-deploy');
        assert.equal(sent.json.max_completion_tokens, 128);
        assert.equal(sent.json.max_tokens, undefined);
        assert.equal(sent.json.temperature, undefined);
        assert.equal(sent.json.top_p, undefined);
        assert.equal(sent.json.top_k, undefined);
        assert.equal(sent.json.stream, undefined);
        assert.equal(sent.json.messages[0].content, 'You are Claude Code');
        assert.equal(JSON.stringify(sent.json).includes('cache_control'), false);
        assertClean(harness.logs.join('\n'), 'logs');

        const spend = JSON.parse(fs.readFileSync(path.join(harness.dir, 'spend.json'), 'utf8'));
        assert.deepEqual(Object.keys(spend).sort(), ['day', 'totalTokens']);
        assert.equal(spend.totalTokens, 8);
        assertClean(JSON.stringify(spend), 'spend file');
    } finally {
        await harness.close();
    }
});

test('streaming text preserves fragments and reports final usage', async () => {
    const harness = await makeHarness({
        onRequest: async (_record, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(sse({ choices: [{ index: 0, delta: { content: 'Hel' } }] }));
            res.write(sse({ choices: [{ index: 0, delta: { content: 'lo' } }] }));
            res.write('data: {"choices":[{"index":0,"delta":{"content":" "}}]}\n');
            res.write('data: {"choices":[{"index":0,"delta":{"content":"there"}}]}\n\n');
            res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
            res.write(sse({
                choices: [],
                usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, prompt_tokens_details: { cached_tokens: 1 } }
            }));
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('Hi'), stream: true }
        });
        assert.equal(response.status, 200);
        assert.match(response.headers['content-type'], /text\/event-stream/);
        assertClean(response.text, 'stream');
        const events = parseSse(response.text);
        assert.equal(events[0].type, 'message_start');
        assert.equal(events[0].message.model, 'claude-sonnet-4-6');
        const text = events
            .filter((event) => event.delta?.type === 'text_delta')
            .map((event) => event.delta.text)
            .join('');
        assert.equal(text, 'Hello there');
        assert.equal(events.some((event) => event.delta?.type === 'thinking_delta'), false);
        const delta = events.find((event) => event.type === 'message_delta');
        assert.equal(delta.delta.stop_reason, 'end_turn');
        assert.equal(delta.usage.output_tokens, 2);
        assert.equal(delta.usage.input_tokens, 3);
        assert.equal(delta.usage.cache_read_input_tokens, 1);
        assert.equal(events.at(-1).type, 'message_stop');
        assert.equal(harness.mock.requests[0].json.stream, true);
        assert.deepEqual(harness.mock.requests[0].json.stream_options, { include_usage: true });
    } finally {
        await harness.close();
    }
});

test('tool round trip keeps client tools, drops server tools, and strips thinking', async () => {
    const harness = await makeHarness({
        onRequest: async (_record, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: null,
                        tool_calls: [{
                            id: 'call_read',
                            type: 'function',
                            function: { name: 'Read', arguments: '{"file_path":"src/app.js"}' }
                        }]
                    },
                    finish_reason: 'tool_calls'
                }],
                usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }
            }));
        }
    });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                model: 'claude-sonnet-4-6',
                max_tokens: 200,
                tool_choice: { type: 'auto' },
                tools: [
                    {
                        name: 'Read',
                        description: 'Read a file',
                        input_schema: {
                            type: 'object',
                            properties: { file_path: { type: 'string', minLength: 1, pattern: '.*' } },
                            required: ['file_path'],
                            additionalProperties: false,
                            $schema: 'http://json-schema.org/draft-07/schema#'
                        }
                    },
                    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
                ],
                messages: [
                    { role: 'user', content: 'Read the file' },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'thinking', thinking: 'secret plan', signature: 'sig' },
                            { type: 'text', text: 'I will read it' },
                            { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'README.md' } }
                        ]
                    },
                    {
                        role: 'user',
                        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file body', is_error: false }]
                    }
                ]
            }
        });
        assert.equal(response.status, 200);
        const json = JSON.parse(response.text);
        assert.equal(json.stop_reason, 'tool_use');
        assert.equal(json.content[0].type, 'tool_use');
        assert.equal(json.content[0].name, 'Read');
        assert.deepEqual(json.content[0].input, { file_path: 'src/app.js' });
        assert.equal(json.content[0].id, 'call_read');

        const sent = harness.mock.requests[0].json;
        assert.deepEqual(sent.tools.map((tool) => tool.function.name), ['Read']);
        assert.equal(sent.tools[0].function.parameters.properties.file_path.minLength, undefined);
        assert.equal(sent.tools[0].function.parameters.properties.file_path.pattern, undefined);
        assert.equal(sent.tools[0].function.parameters.$schema, undefined);
        assert.equal(sent.tools[0].function.parameters.additionalProperties, false);
        assert.equal(JSON.stringify(sent).includes('web_search'), false);
        assert.equal(JSON.stringify(sent).includes('secret plan'), false);
        assert.equal(JSON.stringify(sent).includes('thinking'), false);
        const toolMessage = sent.messages.find((message) => message.role === 'tool');
        assert.equal(toolMessage.tool_call_id, 'toolu_1');
        assert.equal(toolMessage.content, 'file body');
        const assistant = sent.messages.find((message) => message.role === 'assistant');
        assert.equal(assistant.tool_calls[0].function.name, 'Read');
        assert.equal(assistant.tool_calls[0].id, 'toolu_1');
        assert.equal(harness.logs.some((line) => line.includes('web_search')), true);
        assertClean(response.text, 'tool response');
    } finally {
        await harness.close();
    }
});

test('parallel tool-call stream keeps partial JSON in index order', async () => {
    const harness = await makeHarness({
        onRequest: async (_record, res) => {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '' } }] } }] }));
            res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'Bash', arguments: '' } }] } }] }));
            res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_' } }] } }] }));
            res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'path":"a.js"}' } }] } }] }));
            res.write(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"command":"ls"}' } }] } }] }));
            res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
            res.write('data: [DONE]\n\n');
            res.end();
        }
    });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                ...userMessage('do both'),
                stream: true,
                tools: [
                    { name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } },
                    { name: 'Bash', description: 'bash', input_schema: { type: 'object', properties: {} } }
                ]
            }
        });
        assert.equal(response.status, 200);
        const events = parseSse(response.text);
        const starts = events.filter((event) => event.type === 'content_block_start');
        assert.deepEqual(starts.map((event) => event.content_block.name), ['Read', 'Bash']);
        const partials = (index) => events
            .filter((event) => event.type === 'content_block_delta' && event.index === index)
            .map((event) => event.delta.partial_json)
            .join('');
        assert.equal(partials(0), '{"file_path":"a.js"}');
        assert.equal(partials(1), '{"command":"ls"}');
        const delta = events.find((event) => event.type === 'message_delta');
        assert.equal(delta.delta.stop_reason, 'tool_use');
    } finally {
        await harness.close();
    }
});

test('long tool names are shortened on the way out and restored on the way back', async () => {
    const longName = `mcp__filesystem__${'read_file_'.repeat(8)}`;
    assert.ok(longName.length > 64);
    const harness = await makeHarness({
        onRequest: async (record, res) => {
            const short = record.json.tools[0].function.name;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                choices: [{
                    message: {
                        content: null,
                        tool_calls: [{
                            id: 'call_long',
                            type: 'function',
                            function: { name: short, arguments: '{"path":"x"}' }
                        }]
                    },
                    finish_reason: 'tool_calls'
                }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
            }));
        }
    });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                model: 'claude-sonnet-4-6',
                max_tokens: 64,
                messages: [{ role: 'user', content: 'go' }],
                tools: [{ name: longName, description: 'long', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }]
            }
        });
        const short = harness.mock.requests[0].json.tools[0].function.name;
        assert.ok(short.length <= 64);
        assert.match(short, /^[A-Za-z0-9_-]+$/);
        assert.notEqual(short, longName);
        const json = JSON.parse(response.text);
        assert.equal(json.content[0].name, longName);
        assert.deepEqual(json.content[0].input, { path: 'x' });
    } finally {
        await harness.close();
    }
});

test('image blocks become data URLs and http images are not fetched', async () => {
    const harness = await makeHarness();
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                model: 'claude-sonnet-4-6',
                max_tokens: 32,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'what is this' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } },
                        { type: 'image', source: { type: 'url', url: 'http://169.254.169.254/latest/meta-data' } }
                    ]
                }]
            }
        });
        assert.equal(response.status, 200);
        const content = harness.mock.requests[0].json.messages[0].content;
        assert.equal(content[1].type, 'image_url');
        assert.equal(content[1].image_url.url, 'data:image/png;base64,aGVsbG8=');
        assert.equal(JSON.stringify(content).includes('169.254.169.254'), false);
        assert.equal(harness.mock.requests.length, 1);
    } finally {
        await harness.close();
    }
});

test('Azure auth failures use the Anthropic error shape and redact the key', async () => {
    const harness = await makeHarness({
        azureStatus: 401,
        azureBody: { error: { message: `bad key ${AZURE_KEY}` } }
    });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: userMessage('Hi')
        });
        assert.equal(response.status, 401);
        const json = JSON.parse(response.text);
        assert.equal(json.type, 'error');
        assert.equal(json.error.type, 'authentication_error');
        assert.match(json.error.message, /bad key/);
        assertClean(response.text, 'auth error');
        assertClean(harness.logs.join('\n'), 'auth logs');
    } finally {
        await harness.close();
    }
});

test('the daily ceiling returns 429 and does not call Azure again', async () => {
    const harness = await makeHarness({
        maxOutputTokens: 16,
        dailyTokenCeiling: 20,
        azureBody: {
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        }
    });
    try {
        const first = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: userMessage('one')
        });
        assert.equal(first.status, 200);
        const second = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: userMessage('two')
        });
        assert.equal(second.status, 429);
        const json = JSON.parse(second.text);
        assert.equal(json.error.type, 'rate_limit_error');
        assert.match(json.error.message, /ceiling/);
        assert.equal(harness.mock.requests.length, 1);
        assertClean(second.text, 'ceiling');
    } finally {
        await harness.close();
    }
});

test('proxy auth is required and the presented key is not echoed', async () => {
    const harness = await makeHarness();
    const wrong = 'wrong-proxy-key-should-not-echo-99';
    try {
        const missing = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: userMessage('Hi'),
            auth: null
        });
        assert.equal(missing.status, 401);
        const bad = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: userMessage('Hi'),
            auth: wrong
        });
        assert.equal(bad.status, 401);
        assert.equal(bad.text.includes(wrong), false);
        assert.equal(bad.text.includes(AZURE_KEY), false);
        assert.equal(harness.mock.requests.length, 0);
        const health = await request({
            port: harness.proxy.port,
            method: 'GET',
            path: '/health',
            auth: null
        });
        assert.equal(health.status, 401);
    } finally {
        await harness.close();
    }
});

test('a client disconnect aborts the upstream request', async () => {
    let upstreamClosed = false;
    const harness = await makeHarness({
        onRequest: async (record, res) => {
            const socket = record.req.socket;
            socket.on('close', () => {
                upstreamClosed = true;
            });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(sse({ choices: [{ index: 0, delta: { content: 'Hi' } }] }));
            await new Promise((resolve) => socket.on('close', resolve));
        }
    });
    try {
        await new Promise((resolve, reject) => {
            const payload = Buffer.from(JSON.stringify({ ...userMessage('Hi'), stream: true }));
            const req = http.request({
                hostname: '127.0.0.1',
                port: harness.proxy.port,
                method: 'POST',
                path: '/v1/messages',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': payload.length,
                    'x-api-key': PROXY_KEY
                }
            }, (res) => {
                res.on('data', () => req.destroy());
                res.on('error', () => {});
            });
            req.on('error', () => {});
            req.write(payload);
            req.end();
            const timer = setTimeout(() => reject(new Error('upstream was not aborted')), 4000);
            const poll = setInterval(() => {
                if (!upstreamClosed) return;
                clearTimeout(timer);
                clearInterval(poll);
                resolve();
            }, 20);
        });
        assert.equal(upstreamClosed, true);
    } finally {
        await harness.close();
    }
});

test('count_tokens is a local estimate and /v1/models lists Claude aliases', async () => {
    const harness = await makeHarness();
    try {
        const counted = await request({
            port: harness.proxy.port,
            path: '/v1/messages/count_tokens',
            body: userMessage('Hello Claude Code')
        });
        assert.equal(counted.status, 200);
        const count = JSON.parse(counted.text);
        assert.equal(Number.isInteger(count.input_tokens), true);
        assert.ok(count.input_tokens > 0);
        const models = await request({
            port: harness.proxy.port,
            method: 'GET',
            path: '/v1/models'
        });
        const list = JSON.parse(models.text);
        const ids = list.data.map((model) => model.id);
        assert.ok(ids.includes('claude-sonnet-5-5'));
        assert.ok(ids.includes('claude-opus-5-5'));
        assert.ok(ids.includes('claude-haiku-4-5'));
        assert.ok(ids.includes('claude-fable-5-1'));
        assert.equal(ids.includes('claude-sonnet-4-6'), false);
        assert.equal(ids.includes('claude-opus-4-6'), false);
        assert.equal(list.data[0].owned_by, 'azure');
        assert.equal(harness.mock.requests.length, 0);
        assertClean(models.text, 'models');
    } finally {
        await harness.close();
    }
});

test('the local usage page lists requests and hides the Azure key', async () => {
    const harness = await makeHarness();
    try {
        const page = await request({
            port: harness.proxy.port,
            method: 'GET',
            path: '/',
            auth: null
        });
        assert.equal(page.status, 200);
        assert.match(page.text, /Tokens today/);
        assert.match(page.text, /Cost/);
        assert.match(page.text, /Graphs/);
        assert.match(page.text, /Models/);
        assert.match(page.text, /Deploy that model/);
        assert.equal(page.text.includes(AZURE_KEY), false);
        assert.equal(page.text.includes('apiKey'), false);

        await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: userMessage('Hi')
        });
        const usage = await request({
            port: harness.proxy.port,
            method: 'GET',
            path: '/api/usage',
            auth: null
        });
        assert.equal(usage.status, 200);
        assertClean(usage.text, 'usage api');
        const data = JSON.parse(usage.text);
        assert.equal(data.azureKeyLoaded, true);
        assert.equal(data.today.totalTokens, 8);
        assert.equal(data.requests[0].model, 'claude-sonnet-4-6');
        assert.equal(data.requests[0].deployment, 'gpt-deploy');
        assert.equal(data.requests[0].inputTokens, 3);
        assert.equal(data.requests[0].outputTokens, 3);
        assert.equal(data.cost.timeZone, 'UTC');
        assert.equal(data.cost.today.totalTokens, 8);
        assert.equal(data.cost.today.priced, false);
        assert.equal(data.cost.today.unpriced[0].deployment, 'gpt-deploy');
        assert.equal(data.cost.monthStart.endsWith('-01'), true);
        assert.equal(Object.hasOwn(data, 'azureApiKey'), false);
        const stored = fs.readFileSync(path.join(harness.dir, 'requests.json'), 'utf8');
        assertClean(stored, 'request log');
    } finally {
        await harness.close();
    }
});

test('claude model names map to the deployment and other names pass through', async () => {
    const harness = await makeHarness({ opus: 'opus-deploy', deployment: 'gpt-deploy' });
    try {
        const ok = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('Hi'), model: 'claude-opus-4-6-thinking' }
        });
        assert.equal(ok.status, 200);
        assert.equal(JSON.parse(ok.text).model, 'claude-opus-4-6-thinking');
        assert.equal(harness.mock.requests[0].json.model, 'opus-deploy');
        const before = harness.mock.requests.length;
        const bad = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('Hi'), model: 'gpt-4o-mini' }
        });
        assert.equal(bad.status, 200);
        assert.equal(harness.mock.requests[before].json.model, 'gpt-4o-mini');
        assert.equal(JSON.parse(bad.text).model, 'gpt-4o-mini');

        const suffixed = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('ctx'), model: 'claude-sonnet-4-6[1m]' }
        });
        assert.equal(suffixed.status, 200);
        assert.equal(JSON.parse(suffixed.text).model, "claude-sonnet-4-6[1m]");
        assert.equal(harness.mock.requests.at(-1).json.model, 'gpt-deploy');

        const prefixed = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('prefix'), model: 'azure/gpt-6-luna' }
        });
        assert.equal(prefixed.status, 200);
        assert.equal(harness.mock.requests.at(-1).json.model, 'gpt-6-luna');
    } finally {
        await harness.close();
    }
});

test('Claude Code opus and sonnet switches select different deployments', async () => {
    const harness = await makeHarness({
        deployment: 'gpt-6-luna',
        opus: 'gpt-6-astra',
        sonnet: 'gpt-6-luna',
        haiku: 'gpt-6-luna',
        fable: 'gpt-6-astra',
        models: ['gpt-6-luna', 'gpt-6-astra']
    });
    try {
        const opus = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                ...userMessage('plan'),
                model: 'claude-opus-4-6',
                thinking: { type: 'adaptive' }
            }
        });
        assert.equal(opus.status, 200);
        assert.equal(harness.mock.requests[0].json.model, 'gpt-6-astra');
        assert.equal(harness.mock.requests[0].json.reasoning_effort, 'medium');
        assert.equal(JSON.parse(opus.text).content.some((block) => block.type === 'thinking'), false);
        assert.equal(harness.mock.requests[0].headers.authorization, undefined);

        const sonnet = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('edit'), model: 'claude-sonnet-4-6' }
        });
        assert.equal(sonnet.status, 200);
        assert.equal(harness.mock.requests[1].json.model, 'gpt-6-luna');

        const fable = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('fable'), model: 'claude-fable-5' }
        });
        assert.equal(fable.status, 200);
        assert.equal(harness.mock.requests.at(-1).json.model, 'gpt-6-astra');

        const direct = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('direct'), model: 'gpt-6-astra' }
        });
        assert.equal(direct.status, 200);
        assert.equal(harness.mock.requests[2].json.model, 'gpt-6-astra');

        const models = await request({
            port: harness.proxy.port,
            method: 'GET',
            path: '/v1/models'
        });
        const ids = JSON.parse(models.text).data.map((model) => model.id);
        assert.ok(ids.includes('gpt-6-astra'));
        assert.ok(ids.includes('gpt-6-luna'));
        assert.ok(ids.includes('claude-opus-5-5'));
        assert.ok(ids.includes('claude-sonnet-5-5'));
        assert.ok(ids.includes('claude-fable-5-1'));
        assert.equal(ids.includes('claude-opus-4-6'), false);
        assert.equal(ids.includes('claude-sonnet-4-6'), false);
        assertClean(models.text, 'model list');
    } finally {
        await harness.close();
    }
});

test('gpt-5.6 tool calls force reasoning_effort none and a normal deployment does not', async () => {
    const harness = await makeHarness({ deployment: 'gpt-5.6-sol' });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                ...userMessage('use the tool'),
                model: 'claude-sonnet-4-6',
                thinking: { type: 'enabled', budget_tokens: 16000 },
                tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }]
            }
        });
        assert.equal(response.status, 200);
        assert.equal(harness.mock.requests[0].json.reasoning_effort, 'none');
        assert.equal(harness.mock.requests[0].json.temperature, undefined);
    } finally {
        await harness.close();
    }

    const plain = await makeHarness({ deployment: 'gpt-4o-deploy' });
    try {
        await request({
            port: plain.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('hi'), thinking: { type: 'enabled', budget_tokens: 16000 } }
        });
        assert.equal(plain.mock.requests[0].json.reasoning_effort, undefined);
        assert.equal(plain.mock.requests[0].headers['api-key'], AZURE_KEY);
        assert.equal(plain.mock.requests[0].url.includes(AZURE_KEY), false);
    } finally {
        await plain.close();
    }
});

test('gpt-6 tool calls use the Responses API and keep reasoning on', async () => {
    const harness = await makeHarness({
        deployment: 'gpt-6-luna',
        maxOutputTokens: 128000,
        onRequest: async (_record, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                output: [{
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'pong' }]
                }],
                usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
            }));
        }
    });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                ...userMessage('hello'),
                thinking: { type: 'enabled', budget_tokens: 64000 },
                tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }]
            }
        });
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.text).content[0].text, 'pong');
        const sent = harness.mock.requests[0];
        assert.equal(sent.url, '/openai/v1/responses');
        assert.equal(sent.json.reasoning.effort, 'medium');
        assert.equal(sent.json.reasoning.context, 'current_turn');
        assert.equal(sent.json.reasoning.summary, undefined);
        assert.equal(sent.json.store, false);
        assert.deepEqual(sent.json.include, ['reasoning.encrypted_content']);
        assert.equal(sent.json.reasoning_effort, undefined);
        assert.equal(sent.json.max_output_tokens, 16128);
        assert.equal(sent.json.tools[0].name, 'Read');
        assert.equal(sent.json.tools[0].function, undefined);
        assert.equal(sent.json.tools[0].strict, false);
        assertClean(response.text, 'responses reply');
    } finally {
        await harness.close();
    }
});

test('gpt-6 replays encrypted reasoning only inside the current question', async () => {
    const readTool = { name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } };
    const rounds = [];
    const harness = await makeHarness({
        deployment: 'gpt-6-luna',
        onRequest: async (_record, res) => {
            const round = rounds.length + 1;
            rounds.push(round);
            if (round === 1) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end([
                    sse({ type: 'response.output_text.delta', delta: 'checking' }),
                    sse({
                        type: 'response.output_item.added',
                        output_index: 1,
                        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '' }
                    }),
                    sse({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":"skill.md"}' }),
                    sse({
                        type: 'response.completed',
                        response: {
                            output: [
                                { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-trace-1', status: 'completed' },
                                { type: 'message', content: [{ type: 'output_text', text: 'checking' }] },
                                { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"path":"skill.md"}' }
                            ],
                            usage: { input_tokens: 10, output_tokens: 6, total_tokens: 16, output_tokens_details: { reasoning_tokens: 4 } }
                        }
                    })
                ].join(''));
                return;
            }
            if (round === 2) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    output: [
                        { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'enc-trace-2' },
                        { type: 'function_call', id: 'fc_2', call_id: 'call_2', name: 'Read', arguments: '{"path":"lanes.md"}' }
                    ],
                    usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35, output_tokens_details: { reasoning_tokens: 3 } }
                }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'slate' }] }],
                usage: { input_tokens: 40, output_tokens: 2, total_tokens: 42 }
            }));
        }
    });
    try {
        const first = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                ...userMessage('scout'),
                stream: true,
                thinking: { type: 'enabled', budget_tokens: 16000 },
                tools: [readTool]
            }
        });
        assert.equal(first.status, 200);
        assert.equal(first.text.includes('enc-trace-1'), false);
        const tool = parseSse(first.text).find((event) => event.type === 'content_block_start' && event.content_block?.type === 'tool_use');
        assert.equal(tool.content_block.id, 'call_1');

        const second = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                model: 'claude-sonnet-4-6',
                max_tokens: 128,
                thinking: { type: 'enabled', budget_tokens: 16000 },
                tools: [readTool],
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'scout' }] },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'text', text: 'checking' },
                            { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'skill.md' } }
                        ]
                    },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'skill body' }] }
                ]
            }
        });
        assert.equal(second.status, 200);
        assert.equal(second.text.includes('enc-trace-2'), false);
        const replayed = harness.mock.requests[1].json.input;
        assert.equal(replayed[0].content, 'scout');
        assert.equal(replayed[1].type, 'reasoning');
        assert.equal(replayed[1].id, 'rs_1');
        assert.equal(replayed[1].encrypted_content, 'enc-trace-1');
        assert.equal(replayed[2].role, 'assistant');
        assert.equal(replayed[3].type, 'function_call');
        assert.equal(replayed[3].id, 'fc_1');
        assert.equal(replayed[3].call_id, 'call_1');
        assert.equal(replayed[4].type, 'function_call_output');
        assert.equal(replayed[4].call_id, 'call_1');
        assert.equal(replayed[4].output, 'skill body');

        const third = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                model: 'claude-sonnet-4-6',
                max_tokens: 128,
                tools: [readTool],
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'scout' }] },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'text', text: 'checking' },
                            { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'skill.md' } }
                        ]
                    },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'skill body' }] },
                    {
                        role: 'assistant',
                        content: [{ type: 'tool_use', id: 'call_2', name: 'Read', input: { path: 'lanes.md' } }]
                    },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'lane list' }] }
                ]
            }
        });
        assert.equal(third.status, 200);
        const loop = harness.mock.requests[2].json.input;
        const blobs = loop.filter((item) => item.type === 'reasoning').map((item) => item.encrypted_content);
        assert.deepEqual(blobs, ['enc-trace-1', 'enc-trace-2']);
        const secondCall = loop.find((item) => item.type === 'function_call' && item.call_id === 'call_2');
        assert.equal(secondCall.id, 'fc_2');
        assert.ok(loop.findIndex((item) => item.encrypted_content === 'enc-trace-2') < loop.findIndex((item) => item.call_id === 'call_2' && item.type === 'function_call'));

        const fourth = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                model: 'claude-sonnet-4-6',
                max_tokens: 128,
                tools: [readTool],
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'scout' }] },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'text', text: 'checking' },
                            { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'skill.md' } }
                        ]
                    },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'skill body' }] },
                    {
                        role: 'assistant',
                        content: [{ type: 'tool_use', id: 'call_2', name: 'Read', input: { path: 'lanes.md' } }]
                    },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_2', content: 'lane list' }] },
                    { role: 'assistant', content: [{ type: 'text', text: 'slate' }] },
                    { role: 'user', content: [{ type: 'text', text: 'draft it' }] }
                ]
            }
        });
        assert.equal(fourth.status, 200);
        const drafted = harness.mock.requests[3].json.input;
        assert.equal(drafted.some((item) => item.type === 'reasoning'), false);
        assert.equal(drafted.at(-1).content, 'draft it');
        assert.equal(harness.logs.join('\n').includes('enc-trace-1'), false);
    } finally {
        await harness.close();
    }
});

test('a status line shown as thinking goes back to GPT as its own commentary', async () => {
    const harness = await makeHarness({
        deployment: 'gpt-6-luna',
        onRequest: async (_record, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
                usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 }
            }));
        }
    });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                model: 'claude-sonnet-4-6',
                max_tokens: 128,
                tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }],
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'scout' }] },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'thinking', thinking: 'old plan', signature: `enc-${'b'.repeat(40)}` },
                            { type: 'thinking', thinking: 'Memory loaded. Checking the reply log.', signature: 'preamble' },
                            { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'Reply-Log.md' } }
                        ]
                    },
                    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'empty' }] }
                ]
            }
        });
        assert.equal(response.status, 200);
        const input = harness.mock.requests[0].json.input;
        assert.deepEqual(input[1], { role: 'assistant', content: 'Memory loaded. Checking the reply log.', phase: 'commentary' });
        assert.equal(input[2].type, 'function_call');
        assert.equal(JSON.stringify(input).includes('old plan'), false);
    } finally {
        await harness.close();
    }
});

test('a Foundry content filter block is an error, not a refusal in the chat', async () => {
    const refusal = "I'm sorry, but I cannot assist with that request.";
    const filtered = {
        status: 'incomplete',
        incomplete_details: { reason: 'content_filter' },
        content_filters: [{
            blocked: true,
            source_type: 'prompt',
            content_filter_results: { hate: { filtered: true, severity: 'low' }, sexual: { filtered: false, severity: 'safe' } }
        }],
        output: [{ type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: refusal }] }],
        usage: { input_tokens: 50, output_tokens: 12, total_tokens: 62 }
    };
    const harness = await makeHarness({
        deployment: 'gpt-6-luna',
        onRequest: async (record, res) => {
            if (record.json.stream) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.end([
                    sse({ type: 'response.output_text.delta', delta: refusal }),
                    sse({ type: 'response.incomplete', response: filtered })
                ].join(''));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(filtered));
        }
    });
    const body = {
        ...userMessage('write something else. this is shit'),
        tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }]
    };
    try {
        const streamed = await request({ port: harness.proxy.port, path: '/v1/messages', body: { ...body, stream: true } });
        assert.equal(streamed.status, 200);
        assert.equal(streamed.text.includes(refusal), false);
        const events = parseSse(streamed.text);
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'error');
        assert.equal(events[0].error.type, 'invalid_request_error');
        assert.match(events[0].error.message, /content filter/);
        assert.match(events[0].error.message, /hate \(prompt, low\)/);

        const plain = await request({ port: harness.proxy.port, path: '/v1/messages', body });
        assert.equal(plain.status, 400);
        assert.equal(plain.text.includes(refusal), false);
        assert.match(JSON.parse(plain.text).error.message, /hate \(prompt, low\)/);
    } finally {
        await harness.close();
    }
});

test('stored scratchpads are not copied into the chat or reread on the next question', async () => {
    const signature = `enc-from-chat-${'a'.repeat(40)}`;
    const harness = await makeHarness({
        deployment: 'gpt-6-luna',
        maxOutputTokens: 128000,
        onRequest: async (_record, res) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                output: [
                    {
                        type: 'reasoning',
                        id: 'rs_round',
                        summary: [{ type: 'summary_text', text: 'separate the harness from the tools' }],
                        encrypted_content: signature
                    },
                    { type: 'message', content: [{ type: 'output_text', text: 'slate' }] }
                ],
                usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 }
            }));
        }
    });
    try {
        const first = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                ...userMessage('scout'),
                tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }]
            }
        });
        assert.equal(first.status, 200);
        const firstBody = JSON.parse(first.text);
        assert.equal(firstBody.content[0].type, 'text');
        assert.equal(firstBody.content[0].text, 'slate');
        assert.equal(first.text.includes(signature), false);

        const second = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: {
                model: 'claude-sonnet-4-6',
                max_tokens: 128,
                tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } }],
                messages: [
                    { role: 'user', content: [{ type: 'text', text: 'scout' }] },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'thinking', thinking: 'old plan', signature },
                            { type: 'text', text: 'slate' }
                        ]
                    },
                    { role: 'user', content: [{ type: 'text', text: 'draft option 2' }] }
                ]
            }
        });
        assert.equal(second.status, 200);
        const input = harness.mock.requests[1].json.input;
        assert.equal(input.some((item) => item.type === 'reasoning'), false);
        assert.equal(JSON.stringify(input).includes(signature), false);
        assert.equal(input.at(-1).content, 'draft option 2');
    } finally {
        await harness.close();
    }
});

test('reasoning cache reloads the scratchpad after a restart', async () => {
    const { createReasoningCache, traceFromOutput } = await import('../src/providers/azure/reasoning-trace.js');
    const dir = tmpDir();
    try {
        const trace = traceFromOutput([
            { type: 'reasoning', id: 'rs_9', summary: [], encrypted_content: 'enc-9' },
            { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'Read', arguments: '{}' }
        ]);
        createReasoningCache(dir).save(trace);
        const restored = createReasoningCache(dir).lookup(['call_9']);
        assert.equal(restored.items[0].encrypted_content, 'enc-9');
        assert.equal(restored.callItemIds.call_9, 'fc_9');
        assert.equal(traceFromOutput([
            { type: 'reasoning', id: 'rs_x', summary: [] },
            { type: 'function_call', call_id: 'call_x', name: 'Read', arguments: '{}' }
        ]), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('heartbeats do not call Azure or require a key', async () => {
    const harness = await makeHarness();
    try {
        const root = await request({
            port: harness.proxy.port,
            path: '/',
            body: { note: 'heartbeat' },
            auth: null
        });
        const batch = await request({
            port: harness.proxy.port,
            path: '/api/event_logging/batch',
            body: { events: [] },
            auth: null
        });
        assert.equal(root.status, 200);
        assert.equal(batch.status, 200);
        assert.equal(harness.mock.requests.length, 0);
    } finally {
        await harness.close();
    }
});

test('redirects are not followed', async () => {
    let stolen = 0;
    const evil = http.createServer((_req, res) => {
        stolen += 1;
        res.writeHead(200);
        res.end('stolen');
    });
    await new Promise((resolve) => evil.listen(0, '127.0.0.1', resolve));
    const harness = await makeHarness({
        onRequest: async (_record, res) => {
            res.writeHead(302, { Location: `http://127.0.0.1:${evil.address().port}/steal` });
            res.end();
        }
    });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: userMessage('Hi')
        });
        assert.equal(response.status, 502);
        assert.equal(stolen, 0);
        assert.equal(harness.mock.requests.length, 1);
        assertClean(response.text, 'redirect error');
    } finally {
        await harness.close();
        await new Promise((done) => evil.close(done));
    }
});

test('endpoint rules, secret-bearing config, and a fresh UTC day', async () => {
    const { assertSafeAzureUrl } = await import('../src/providers/azure/endpoint.js');
    const { resolveSettings, assertConfigHasNoSecrets } = await import('../src/providers/azure/settings.js');
    const { SpendGuard } = await import('../src/providers/azure/spend-guard.js');
    const { sanitizeSchema } = await import('../src/providers/azure/schema.js');
    const { createAzureClient } = await import('../src/providers/azure/client.js');
    const { redactSecrets } = await import('../src/providers/azure/redact.js');

    assert.equal(
        assertSafeAzureUrl(`https://${ALLOWED_HOST}/openai/v1`, { allowHosts: [ALLOWED_HOST] }),
        `https://${ALLOWED_HOST}/openai/v1`
    );
    assert.throws(() => assertSafeAzureUrl('http://evil.example/openai/v1', { allowHosts: ['evil.example'] }), /https/);
    assert.throws(() => assertSafeAzureUrl(`https://evil.example/openai/v1`, { allowHosts: [ALLOWED_HOST] }), /allowlisted/);
    assert.throws(() => assertSafeAzureUrl(`https://user:secret@${ALLOWED_HOST}/openai/v1`, { allowHosts: [ALLOWED_HOST] }), /credentials/);
    assert.throws(() => assertSafeAzureUrl(`https://${ALLOWED_HOST}/openai/v1?api-key=${AZURE_KEY}`, { allowHosts: [ALLOWED_HOST] }), /query/);
    assert.throws(() => assertSafeAzureUrl('http://127.0.0.1:9/openai/v1', { allowHosts: ['127.0.0.1'] }), /https/);

    const cleaned = sanitizeSchema({
        type: 'object',
        $schema: 'http://json-schema.org/draft-07/schema#',
        properties: {
            mode: { const: 'fast', description: 'speed' },
            name: { type: ['string', 'null'], pattern: '.*' }
        }
    });
    assert.deepEqual(cleaned.properties.mode.enum, ['fast']);
    assert.equal(cleaned.$schema, undefined);
    assert.equal(cleaned.properties.name.pattern, undefined);
    assert.equal(cleaned.properties.name.type, 'string');

    assert.equal(redactSecrets(`api-key: ${AZURE_KEY}`, [AZURE_KEY]).includes(AZURE_KEY), false);
    assert.equal(redactSecrets(`Bearer ${PROXY_KEY}`, [PROXY_KEY]).includes(PROXY_KEY), false);

    const dir = tmpDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
        apiKey: AZURE_KEY,
        defaultDeployment: 'gpt-deploy'
    }));
    let rejected = null;
    try {
        resolveSettings({
            useProcessEnv: false,
            configPath,
            dataDir: dir,
            proxyApiKey: PROXY_KEY,
            azureApiKey: AZURE_KEY,
            endpoint: `https://${ALLOWED_HOST}/openai/v1`
        });
    } catch (error) {
        rejected = error;
    }
    assert.ok(rejected, 'config with a secret key must be rejected');
    assert.match(rejected.message, /must not contain secrets/);
    assert.equal(rejected.message.includes(AZURE_KEY), false);

    const spendPath = path.join(dir, 'spend.json');
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    fs.writeFileSync(spendPath, JSON.stringify({ day: yesterday, totalTokens: 999999 }));
    const guard = new SpendGuard({ filePath: spendPath, ceiling: 50 });
    const reserved = await guard.beforeRequest(16);
    await guard.commit(reserved, 7);
    const saved = JSON.parse(fs.readFileSync(spendPath, 'utf8'));
    assert.equal(saved.totalTokens, 7);
    assert.equal(saved.day, new Date().toISOString().slice(0, 10));
    assert.equal(Object.hasOwn(saved, 'reserved'), false);

    let captured;
    const client = createAzureClient({
        endpoint: `https://${ALLOWED_HOST}/openai/v1`,
        apiKey: AZURE_KEY,
        allowHosts: [ALLOWED_HOST],
        fetchImpl: async (url, options) => {
            captured = { url, options };
            return new Response(JSON.stringify({
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 }
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
    });
    await client.complete({ model: 'gpt-deploy', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(captured.options.redirect, 'error');
    assert.equal(captured.options.headers['api-key'], AZURE_KEY);
    assert.equal(captured.options.headers.authorization, undefined);
    assert.equal(captured.url.includes(AZURE_KEY), false);
    assert.equal(captured.url, `https://${ALLOWED_HOST}/openai/v1/chat/completions`);
    assertConfigHasNoSecrets({ aliases: { 'claude-sonnet-4-6': 'gpt-deploy' } }, 'example');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('the Azure entrypoint does not import Google account code', () => {
    const root = path.join(__dirname, '..');
    const main = fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8');
    assert.equal(main.includes('account-manager'), false);
    assert.equal(main.includes('cloudcode'), false);
    assert.equal(main.includes('utils/proxy'), false);
    assert.equal(main.includes('allowHttpLoopback: true'), false);
    const providerDir = path.join(root, 'src', 'providers', 'azure');
    for (const file of fs.readdirSync(providerDir)) {
        const text = fs.readFileSync(path.join(providerDir, file), 'utf8');
        assert.equal(/account-manager|cloudcode|utils\/proxy|from '\.\.\/\.\.\/config\.js'/.test(text), false, file);
    }
});

test('a local env file remembers Foundry settings and does not override the shell', async () => {
    const { prepareLocalEnv } = await import('../src/load-env.js');
    const dir = tmpDir();
    const example = path.join(dir, '.env.example');
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(example, [
        'AZURE_OPENAI_API_KEY=',
        'AZURE_OPENAI_ENDPOINT=https://example.services.ai.azure.com/openai/v1',
        ''
    ].join('\n'));
    const env = {
        AZURE_OPENAI_API_KEY: 'file-key-0123456789',
        AZURE_OPENAI_ENDPOINT: 'https://shell.example/openai/v1'
    };
    try {
        const first = prepareLocalEnv({ envPath, examplePath: example, env });
        assert.equal(first.ok, true);
        const saved = fs.readFileSync(envPath, 'utf8');
        assert.match(saved, /^AZURE_OPENAI_API_KEY=file-key-0123456789$/m);
        assert.match(saved, /^AZURE_OPENAI_ENDPOINT=https:\/\/shell\.example\/openai\/v1$/m);
        const fresh = {};
        const second = prepareLocalEnv({ envPath, examplePath: example, env: fresh });
        assert.equal(second.ok, true);
        assert.equal(fresh.AZURE_OPENAI_API_KEY, 'file-key-0123456789');
        assert.equal(fresh.AZURE_OPENAI_ENDPOINT, 'https://shell.example/openai/v1');
        const missing = prepareLocalEnv({
            envPath: path.join(dir, 'empty.env'),
            examplePath: example,
            env: {}
        });
        assert.equal(missing.ok, false);
        assert.match(missing.message, /AZURE_OPENAI_API_KEY/);
        assert.equal(missing.message.includes('file-key'), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('an endpoint is required and its host is the allowlist when none is set', async () => {
    const { resolveSettings } = await import('../src/providers/azure/settings.js');
    const base = {
        useProcessEnv: false,
        skipConfigFile: true,
        azureApiKey: AZURE_KEY,
        deployment: 'gpt-6-luna',
        dataDir: tmpDir()
    };
    assert.throws(() => resolveSettings(base), /AZURE_OPENAI_ENDPOINT/);
    assert.throws(() => resolveSettings({
        ...base,
        endpoint: 'https://YOUR_RESOURCE.services.ai.azure.com/openai/v1'
    }), /YOUR_RESOURCE/);
    assert.throws(() => resolveSettings({
        ...base,
        endpoint: `https://${ALLOWED_HOST}/openai/v1`,
        deployment: 'your-deployment-name'
    }), /your-deployment-name/);
    const settings = resolveSettings({
        ...base,
        endpoint: `https://${ALLOWED_HOST}/openai/v1`
    });
    assert.deepEqual(settings.allowHosts, [ALLOWED_HOST]);
});

test('Foundry mode refuses a non-loopback bind', async () => {
    const { resolveSettings } = await import('../src/providers/azure/settings.js');
    assert.throws(() => resolveSettings({
        useProcessEnv: false,
        skipConfigFile: true,
        host: '0.0.0.0',
        proxyApiKey: PROXY_KEY,
        azureApiKey: AZURE_KEY,
        deployment: 'gpt-deploy',
        endpoint: `https://${ALLOWED_HOST}/openai/v1`,
        allowHosts: [ALLOWED_HOST],
        dataDir: tmpDir()
    }), /127\.0\.0\.1/);
    const settings = resolveSettings({
        useProcessEnv: false,
        skipConfigFile: true,
        proxyApiKey: PROXY_KEY,
        azureApiKey: AZURE_KEY,
        deployment: 'gpt-6-luna',
        endpoint: `https://${ALLOWED_HOST}/openai/v1`,
        allowHosts: [ALLOWED_HOST],
        dataDir: tmpDir()
    });
    assert.equal(settings.dailyTokenCeiling, 50000000);
});

test('gpt-6-luna cache writes are priced once and reasoning stays inside output', async () => {
    const harness = await makeHarness({
        deployment: 'gpt-6-luna',
        azureBody: {
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: {
                prompt_tokens: 1000,
                completion_tokens: 10,
                total_tokens: 1010,
                prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1000 },
                completion_tokens_details: { reasoning_tokens: 4 }
            }
        }
    });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: userMessage('Hi')
        });
        assert.equal(response.status, 200);
        const json = JSON.parse(response.text);
        assert.equal(json.usage.input_tokens, 0);
        assert.equal(json.usage.cache_creation_input_tokens, 1000);
        assert.equal(json.usage.cache_read_input_tokens, 0);
        assert.equal(json.usage.output_tokens, 10);
        assert.equal(Object.hasOwn(json.usage, 'reasoning_tokens'), false);
        const usage = await request({
            port: harness.proxy.port,
            method: 'GET',
            path: '/api/usage',
            auth: null
        });
        const data = JSON.parse(usage.text);
        assert.equal(data.cost.today.micros, '130');
        assert.equal(data.cost.today.usd, '0.000130');
        assert.equal(data.cost.today.fresh, 0);
        assert.equal(data.cost.today.write, 1000);
        assert.equal(data.cost.today.output, 10);
        assert.equal(data.cost.today.reasoning, 4);
        assert.equal(data.cost.today.deployments[0].lane, 'short');
        assert.equal(data.today.totalTokens, 1010);
        const ledger = fs.readFileSync(path.join(harness.dir, 'ledger.json'), 'utf8');
        assertClean(ledger, 'ledger');
        assert.equal(ledger.includes('Hi'), false);
    } finally {
        await harness.close();
    }
});

test('GPT-6 chat calls omit stop so Claude Code safety checks are not rejected', async () => {
    const harness = await makeHarness({ deployment: 'gpt-6-luna', sonnet: 'gpt-6-luna' });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('classify'), stop_sequences: ['END', ''] }
        });
        assert.equal(response.status, 200);
        const sent = harness.mock.requests[0];
        assert.equal(sent.url, '/openai/v1/chat/completions');
        assert.equal(sent.json.stop, undefined);
        assert.equal(sent.json.model, 'gpt-6-luna');
    } finally {
        await harness.close();
    }
});

test('a non-reasoning deployment still receives stop sequences', async () => {
    const harness = await makeHarness({ deployment: 'gpt-4o' });
    try {
        const response = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('classify'), model: 'gpt-4o', stop_sequences: ['END'] }
        });
        assert.equal(response.status, 200);
        assert.deepEqual(harness.mock.requests[0].json.stop, ['END']);
    } finally {
        await harness.close();
    }
});

test('the dashboard mapping changes the next Claude request', async () => {
    const harness = await makeHarness({
        deployment: 'gpt-6-luna',
        opus: 'gpt-6.1-sol',
        sonnet: 'gpt-6-luna',
        haiku: 'gpt-6-luna',
        fable: 'gpt-6.1-sol'
    });
    const routes = {
        'claude-haiku-4-5': 'gpt-6-luna',
        'claude-sonnet-5-5': 'gpt-6-sol',
        'claude-opus-5-5': 'gpt-6-astra',
        'claude-fable-5-1': 'gpt-6.1-sol'
    };
    try {
        const rejected = await request({
            port: harness.proxy.port,
            path: '/api/routing',
            auth: null,
            body: { routes: { 'claude-opus-5-5': 'gpt-4o' } }
        });
        assert.equal(rejected.status, 400);
        const saved = await request({
            port: harness.proxy.port,
            path: '/api/routing',
            auth: null,
            body: { routes }
        });
        assert.equal(saved.status, 200);
        assert.match(JSON.parse(saved.text).notice, /Restart Claude Code/);
        const opus = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('plan'), model: 'claude-opus-5-5' }
        });
        assert.equal(opus.status, 200);
        assert.equal(harness.mock.requests.at(-1).json.model, 'gpt-6-astra');
        const older = await request({
            port: harness.proxy.port,
            path: '/v1/messages',
            body: { ...userMessage('edit'), model: 'claude-sonnet-4-6' }
        });
        assert.equal(older.status, 200);
        assert.equal(harness.mock.requests.at(-1).json.model, 'gpt-6-sol');
        const file = fs.readFileSync(path.join(harness.dir, 'routing.json'), 'utf8');
        assert.equal(file.includes(AZURE_KEY), false);
        assert.match(file, /gpt-6-astra/);
        const usage = await request({
            port: harness.proxy.port,
            method: 'GET',
            path: '/api/usage',
            auth: null
        });
        const data = JSON.parse(usage.text);
        assert.equal(data.routing.catalog.length, 4);
        assert.equal(data.routing.routes.find((route) => route.id === 'claude-opus-5-5').deployment, 'gpt-6-astra');
        assert.ok(Array.isArray(data.cost.days));
        assert.equal(typeof data.cost.days[0].fresh, 'number');
    } finally {
        await harness.close();
    }
});

test('the cost month starts on the UTC 1st and long context reprices the whole request', async () => {
    const { UsageLedger } = await import('../src/providers/azure/ledger.js');
    const { bucketMicros, contextLane, rateKey } = await import('../src/providers/azure/pricing.js');
    assert.equal(contextLane(272000), 'short');
    assert.equal(contextLane(272001), 'long');
    assert.equal(rateKey('gpt-6.1-sol'), 'gpt-6.1-sol');
    assert.equal(rateKey('gpt-6-sol'), 'gpt-6-sol');
    assert.equal(bucketMicros('gpt-6-luna', 'short', { fresh: 1000000, cached: 0, write: 0, output: 0 }), 100000n);
    assert.equal(bucketMicros('gpt-6-luna', 'long', { fresh: 272001, cached: 0, write: 0, output: 0 }), 272001n * 200000n / 1000000n);
    assert.equal(bucketMicros('gpt-6.1-sol', 'short', { fresh: 0, cached: 1000000, write: 0, output: 0 }), 100000n);
    assert.equal(bucketMicros('gpt-6-sol', 'short', { fresh: 0, cached: 1000000, write: 0, output: 0 }), 200000n);

    const dir = tmpDir();
    try {
        const ledger = new UsageLedger(path.join(dir, 'ledger.json'));
        const row = (id, at, fresh, prompt = fresh) => ({
            id,
            at,
            status: 200,
            deployment: 'gpt-6-luna',
            freshTokens: fresh,
            inputTokens: fresh,
            cachedTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
            promptTokens: prompt,
            totalTokens: fresh
        });
        await ledger.apply(row('sept', '2026-09-30T23:00:00.000Z', 100000));
        await ledger.apply(row('oct', '2026-10-01T00:00:00.000Z', 100000));
        await ledger.apply(row('oct', '2026-10-01T01:00:00.000Z', 100000));
        await ledger.apply(row('long', '2026-10-02T00:00:00.000Z', 272001, 272001));
        const summary = ledger.summary('2026-10-02');
        assert.equal(summary.monthStart, '2026-10-01');
        assert.equal(summary.monthEnd, '2026-10-31');
        assert.equal(summary.days.length, 31);
        assert.equal(summary.days[0].day, '2026-10-01');
        assert.equal(summary.days[0].micros, '10000');
        assert.equal(summary.today.requests, 1);
        assert.equal(summary.today.deployments[0].lane, 'long');
        assert.equal(summary.month.requests, 2);
        assert.equal(summary.month.micros, (10000n + (272001n * 200000n / 1000000n)).toString());
        assert.equal(summary.days[30].micros, '0');
        const saved = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8');
        assert.equal(saved.includes('2026-09-30'), true);
        assert.equal(JSON.parse(saved).days['2026-10-01']['gpt-6-luna'].short.requests, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

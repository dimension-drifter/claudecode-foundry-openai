/**
 * Foundry settings. The API key is read from the environment and is never
 * written into the config file.
 */

import fs from 'fs';
import path from 'path';
import { assertSafeAzureUrl } from './endpoint.js';
import { resolveAzureDataDir } from '../../paths.js';

const SECRET_KEY = /^(api[-_]?key|azure[-_]?openai[-_]?api[-_]?key|authorization|webui[-_]?password|access[-_]?token|refresh[-_]?token)$/i;

/**
 * @param {object} value
 * @param {string} label
 */
export function assertConfigHasNoSecrets(value, label) {
    walk(value, label);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function walk(value, label) {
    if (Array.isArray(value)) {
        for (const item of value) walk(item, label);
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        if (SECRET_KEY.test(key)) {
            throw new Error(`${label} must not contain secrets (${key})`);
        }
        walk(child, label);
    }
}

/**
 * @param {object} options
 * Explicit options win. Process env is read only when useProcessEnv is true,
 * so unit tests cannot pick up a real AZURE_OPENAI_API_KEY.
 */
export function resolveSettings(options = {}) {
    const env = options.useProcessEnv === true ? process.env : (options.env || {});
    const dataDir = options.dataDir
        || env.AZURE_DATA_DIR
        || resolveAzureDataDir();

    let fileConfig = {};
    if (options.configPath) {
        fileConfig = readConfigFile(options.configPath);
    } else if (options.skipConfigFile !== true && options.useProcessEnv === true) {
        const defaultPath = path.join(dataDir, 'config.json');
        if (fs.existsSync(defaultPath)) fileConfig = readConfigFile(defaultPath);
    }

    const endpoint = options.endpoint || env.AZURE_OPENAI_ENDPOINT || fileConfig.endpoint || '';
    if (!endpoint) {
        throw new Error('Set AZURE_OPENAI_ENDPOINT to https://YOUR_RESOURCE.services.ai.azure.com/openai/v1');
    }
    if (String(endpoint).includes('YOUR_RESOURCE')) {
        throw new Error('Replace YOUR_RESOURCE in AZURE_OPENAI_ENDPOINT with the host from your Foundry project');
    }
    let allowHosts = options.allowHosts
        || splitHosts(env.AZURE_OPENAI_ALLOW_HOSTS)
        || fileConfig.allowHosts
        || null;
    if (!allowHosts) {
        try {
            allowHosts = [new URL(endpoint).hostname];
        } catch {
            allowHosts = [];
        }
    }

    const normalized = assertSafeAzureUrl(endpoint, {
        allowHosts,
        allowHttpLoopback: options.allowHttpLoopback === true
    });

    const aliases = {
        ...(fileConfig.aliases || {}),
        ...(options.aliases || {})
    };

    const settings = {
        endpoint: normalized,
        allowHosts,
        allowHttpLoopback: options.allowHttpLoopback === true,
        azureApiKey: options.azureApiKey ?? env.AZURE_OPENAI_API_KEY ?? '',
        proxyApiKey: options.proxyApiKey ?? env.API_KEY ?? '',
        defaultDeployment: options.deployment
            || env.AZURE_OPENAI_DEPLOYMENT
            || fileConfig.defaultDeployment
            || '',
        opus: options.opus || env.AZURE_OPENAI_DEPLOYMENT_OPUS || fileConfig.opus || '',
        sonnet: options.sonnet || env.AZURE_OPENAI_DEPLOYMENT_SONNET || fileConfig.sonnet || '',
        haiku: options.haiku || env.AZURE_OPENAI_DEPLOYMENT_HAIKU || fileConfig.haiku || '',
        fable: options.fable || env.AZURE_OPENAI_DEPLOYMENT_FABLE || fileConfig.fable || '',
        models: modelList(options.models, env.AZURE_OPENAI_MODELS, fileConfig.models),
        reasoningEffort: effortSetting(options.reasoningEffort ?? env.AZURE_REASONING_EFFORT ?? fileConfig.reasoningEffort),
        aliases,
        maxOutputTokens: integerSetting(
            options.maxOutputTokens,
            env.AZURE_MAX_OUTPUT_TOKENS,
            fileConfig.maxOutputTokens,
            128000,
            1,
            200000,
            'AZURE_MAX_OUTPUT_TOKENS'
        ),
        dailyTokenCeiling: integerSetting(
            options.dailyTokenCeiling,
            env.AZURE_DAILY_TOKEN_CEILING,
            fileConfig.dailyTokenCeiling,
            20000000,
            0,
            1000000000000,
            'AZURE_DAILY_TOKEN_CEILING'
        ),
        dataDir,
        host: bindHost(options.host || env.AZURE_HOST),
        port: portSetting(options.port || env.AZURE_PORT)
    };

    if (!settings.defaultDeployment && settings.models.length > 0) {
        settings.defaultDeployment = settings.models[0];
    }
    if ([settings.defaultDeployment, settings.opus, settings.sonnet, settings.haiku, settings.fable].includes('your-deployment-name')) {
        throw new Error('Replace your-deployment-name in .env with a deployment from your Foundry project');
    }

    if (options.requireSecrets !== false && !settings.azureApiKey) {
        throw new Error('Set AZURE_OPENAI_API_KEY');
    }

    return settings;
}

/**
 * @param {string|undefined} model
 * @param {ReturnType<typeof resolveSettings>} settings
 * @returns {string}
 */
/**
 * Claude Code and Claude Code Router send model ids with a context suffix
 * (`claude-sonnet-4-6[1m]`) or a provider prefix (`azure/gpt-6-luna`, `openai,gpt-4o`).
 * @param {string} model
 * @returns {string}
 */
export function normalizeClientModel(model) {
    let name = String(model || '').trim().replace(/\[[^\]]+\]\s*$/, '');
    const comma = name.indexOf(',');
    if (comma > 0 && comma < name.length - 1) {
        const tail = name.slice(comma + 1).trim();
        if (tail) name = tail;
    }
    const slash = name.lastIndexOf('/');
    if (slash > 0 && slash < name.length - 1) {
        const tail = name.slice(slash + 1).trim();
        if (tail) name = tail;
    }
    return name;
}

export function resolveDeployment(model, settings) {
    const requested = normalizeClientModel(model);
    if (!requested) return settings.defaultDeployment || settings.models?.[0] || 'default';
    if (settings.aliases?.[requested]) return settings.aliases[requested];

    const lower = requested.toLowerCase();
    if (lower.includes('fable') && (settings.fable || settings.opus)) return settings.fable || settings.opus;
    if (lower.includes('opus') && settings.opus) return settings.opus;
    if (lower.includes('sonnet') && settings.sonnet) return settings.sonnet;
    if ((lower.includes('haiku') || lower.includes('small-fast') || lower.includes('small_fast')) && settings.haiku) {
        return settings.haiku;
    }

    const configured = new Set([
        settings.defaultDeployment,
        settings.opus,
        settings.sonnet,
        settings.haiku,
        settings.fable,
        ...(settings.models || []),
        ...Object.values(settings.aliases || {})
    ].filter(Boolean));
    if (configured.has(requested)) return requested;

    if (lower.includes('claude') && settings.defaultDeployment) return settings.defaultDeployment;
    return requested;
}

/**
 * Model ids Claude Code can be pointed at. Any other claude* name still
 * resolves through the default deployment at request time.
 * @param {ReturnType<typeof resolveSettings>} settings
 * @returns {string[]}
 */
export function listModelIds(settings) {
    const ids = new Set(Object.keys(settings.aliases || {}));
    for (const name of settings.models || []) ids.add(name);
    if (settings.defaultDeployment) ids.add(settings.defaultDeployment);
    if (settings.opus) ids.add(settings.opus);
    if (settings.sonnet) ids.add(settings.sonnet);
    if (settings.haiku) ids.add(settings.haiku);
    if (settings.fable) ids.add(settings.fable);
    if (settings.defaultDeployment || settings.opus) ids.add('claude-opus-5-5');
    if (settings.defaultDeployment || settings.sonnet) ids.add('claude-sonnet-5-5');
    if (settings.defaultDeployment || settings.haiku) ids.add('claude-haiku-4-5');
    if (settings.fable || settings.opus || settings.defaultDeployment) ids.add('claude-fable-5-1');
    return [...ids];
}

/**
 * @param {string} file
 */
function readConfigFile(file) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error && error.code === 'ENOENT') return {};
        throw new Error('Azure config file is not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Azure config file must be a JSON object');
    }
    assertConfigHasNoSecrets(parsed, 'Azure config file');
    return parsed;
}

/**
 * @param {string|undefined} value
 * @returns {string[]|null}
 */
function splitHosts(value) {
    if (!value) return null;
    return value.split(',').map((host) => host.trim()).filter(Boolean);
}

/**
 * @param {unknown} option
 * @param {unknown} envValue
 * @param {unknown} fileValue
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {string} name
 */
function integerSetting(option, envValue, fileValue, fallback, min, max, name) {
    const raw = option !== undefined ? option : (envValue !== undefined && envValue !== '' ? envValue : fileValue);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const number = Number(raw);
    if (!Number.isInteger(number) || number < min || number > max) return fallback;
    return number;
}

/**
 * @param {string|undefined} value
 */
function bindHost(value) {
    const host = value || '127.0.0.1';
    if (host === 'localhost' || host === '::1') return '127.0.0.1';
    if (host === '127.0.0.1') return host;
    throw new Error('Azure mode only binds to 127.0.0.1');
}

/**
 * @param {unknown} option
 * @param {unknown} envValue
 * @param {unknown} fileValue
 * @returns {string[]}
 */
function modelList(option, envValue, fileValue) {
    const raw = option !== undefined ? option : (envValue !== undefined && envValue !== '' ? envValue : fileValue);
    if (!raw) return [];
    const items = Array.isArray(raw) ? raw : String(raw).split(',');
    return items.map((item) => String(item).trim()).filter(Boolean);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function effortSetting(value) {
    if (value === undefined || value === null || value === '') return '';
    const effort = String(value).trim().toLowerCase();
    const allowed = new Set(['none', 'low', 'medium', 'high', 'xhigh']);
    if (!allowed.has(effort)) return '';
    return effort;
}

function portSetting(value) {
    if (value === undefined || value === null || value === '') return 8081;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('AZURE_PORT must be a TCP port');
    }
    return port;
}

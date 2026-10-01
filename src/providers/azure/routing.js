/**
 * Claude model → Foundry deployment choices.
 * The file stores deployment names only.
 */

import fs from 'fs';
import path from 'path';
import { writeEnvValues } from '../../load-env.js';

export const GPT_MODELS = [
    { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra' }
];

export const CLAUDE_ROUTES = [
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5', family: 'haiku', env: 'AZURE_OPENAI_DEPLOYMENT_HAIKU' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', family: 'sonnet', env: 'AZURE_OPENAI_DEPLOYMENT_SONNET', setsDefault: true },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', family: 'opus', env: 'AZURE_OPENAI_DEPLOYMENT_OPUS' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'fable', env: 'AZURE_OPENAI_DEPLOYMENT_FABLE' }
];

const GPT_IDS = new Set(GPT_MODELS.map((model) => model.id));

/**
 * @param {string} dataDir
 * @returns {string}
 */
export function routingFile(dataDir) {
    return path.join(dataDir, 'routing.json');
}

/**
 * @param {object} settings
 */
export function loadRouting(settings) {
    const saved = readRouting(settings.dataDir);
    if (!saved) return null;
    const map = {};
    for (const route of CLAUDE_ROUTES) {
        map[route.id] = GPT_IDS.has(saved[route.id]) ? saved[route.id] : fallback(settings, route);
    }
    applyRouting(settings, map);
    return map;
}

/**
 * @param {object} settings
 * @param {object} routes
 * @param {string} [envPath]
 */
export function saveRouting(settings, routes, envPath) {
    if (!routes || typeof routes !== 'object' || Array.isArray(routes)) {
        throw new Error('Choose a Foundry model for each Claude model');
    }
    const map = {};
    for (const route of CLAUDE_ROUTES) {
        const chosen = routes[route.id];
        if (!GPT_IDS.has(chosen)) {
            throw new Error(`Choose a deployed Foundry model for ${route.label}`);
        }
        map[route.id] = chosen;
    }
    applyRouting(settings, map);
    const file = routingFile(settings.dataDir);
    const body = JSON.stringify({ routes: map });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    try {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
        fs.renameSync(tmp, file);
    } catch {
        fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
        fs.rmSync(tmp, { force: true });
    }
    const envValues = {};
    for (const route of CLAUDE_ROUTES) {
        if (route.env) envValues[route.env] = map[route.id];
    }
    envValues.AZURE_OPENAI_DEPLOYMENT = map['claude-sonnet-5-5'];
    if (envPath) writeEnvValues(envPath, envValues);
    return publicRouting(settings);
}

/**
 * @param {object} settings
 */
export function publicRouting(settings) {
    const saved = readRouting(settings.dataDir) || {};
    return {
        catalog: GPT_MODELS,
        routes: CLAUDE_ROUTES.map((route) => ({
            id: route.id,
            label: route.label,
            family: route.family,
            deployment: GPT_IDS.has(saved[route.id]) ? saved[route.id] : fallback(settings, route)
        }))
    };
}

/**
 * @param {object} settings
 * @param {Record<string, string>} map
 */
function applyRouting(settings, map) {
    settings.aliases = {
        ...(settings.aliases || {}),
        ...map
    };
    settings.haiku = map['claude-haiku-4-5'];
    settings.sonnet = map['claude-sonnet-5-5'];
    settings.opus = map['claude-opus-5-5'];
    settings.fable = map['claude-fable-5-1'];
    settings.defaultDeployment = map['claude-sonnet-5-5'];
    settings.models = [...new Set(Object.values(map))];
}

/**
 * @param {string} dataDir
 * @returns {Record<string, string>|null}
 */
function readRouting(dataDir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(routingFile(dataDir), 'utf8'));
        if (!parsed || typeof parsed.routes !== 'object' || Array.isArray(parsed.routes)) return null;
        return parsed.routes;
    } catch {
        return null;
    }
}

/**
 * @param {object} settings
 * @param {{ family: string }} route
 */
function fallback(settings, route) {
    const family = {
        haiku: settings.haiku,
        sonnet: settings.sonnet,
        opus: settings.opus,
        fable: settings.fable || settings.opus
    }[route.family];
    if (GPT_IDS.has(family)) return family;
    if (GPT_IDS.has(settings.defaultDeployment)) return settings.defaultDeployment;
    return 'gpt-6-luna';
}

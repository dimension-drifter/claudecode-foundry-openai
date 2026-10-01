/**
 * Load a local .env file into the process environment.
 * Values already set in the shell win. The file is the memory between WSL sessions.
 */

import fs from 'fs';

const KNOWN = [
    'AZURE_OPENAI_API_KEY',
    'AZURE_OPENAI_ENDPOINT',
    'AZURE_OPENAI_ALLOW_HOSTS',
    'AZURE_OPENAI_DEPLOYMENT',
    'AZURE_OPENAI_DEPLOYMENT_OPUS',
    'AZURE_OPENAI_DEPLOYMENT_SONNET',
    'AZURE_OPENAI_DEPLOYMENT_HAIKU',
    'AZURE_OPENAI_DEPLOYMENT_FABLE',
    'AZURE_OPENAI_MODELS',
    'AZURE_DAILY_TOKEN_CEILING',
    'AZURE_MAX_OUTPUT_TOKENS',
    'AZURE_REASONING_EFFORT',
    'AZURE_DATA_DIR',
    'AZURE_PORT',
    'AZURE_HOST',
    'API_KEY'
];

/**
 * @param {string} filePath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function loadEnvFile(filePath, env = process.env) {
    if (!fs.existsSync(filePath)) return false;
    const text = fs.readFileSync(filePath, 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (env[key] == null || env[key] === '') env[key] = value;
    }
    return true;
}

/**
 * Create .env on the first run, fill it from the shell when those variables
 * are already set, and refuse to start until the Foundry key is present.
 * @param {{ envPath: string, examplePath: string, env?: NodeJS.ProcessEnv }} options
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function prepareLocalEnv({ envPath, examplePath, env = process.env }) {
    if (!fs.existsSync(envPath)) {
        if (!fs.existsSync(examplePath)) {
            return { ok: false, message: 'Missing .env.example' };
        }
        fs.copyFileSync(examplePath, envPath);
        try { fs.chmodSync(envPath, 0o600); } catch { /* Windows ACLs differ */ }
    }
    loadEnvFile(envPath, env);
    persistKnown(envPath, env);
    if (!env.AZURE_OPENAI_API_KEY) {
        return {
            ok: false,
            message: 'Fill in .env: AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and your deployment names. Then run npm start again.'
        };
    }
    return { ok: true };
}

/**
 * @param {string} filePath
 * @param {NodeJS.ProcessEnv} env
 */
function persistKnown(filePath, env) {
    const original = fs.readFileSync(filePath, 'utf8');
    const lines = original.split(/\r?\n/);
    const seen = new Set();
    const next = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) return line;
        const key = trimmed.slice(0, eq).trim();
        if (!KNOWN.includes(key)) return line;
        seen.add(key);
        const value = env[key];
        if (typeof value !== 'string' || value === '' || value.includes('\n')) return line;
        return `${key}=${formatValue(value)}`;
    });
    for (const key of KNOWN) {
        if (seen.has(key)) continue;
        const value = env[key];
        if (typeof value !== 'string' || value === '' || value.includes('\n')) continue;
        next.push(`${key}=${formatValue(value)}`);
    }
    const body = `${next.filter((line, index) => line !== '' || index < next.length - 1).join('\n').replace(/\n+$/, '')}\n`;
    const normalized = original.endsWith('\n') ? original : `${original}\n`;
    if (body === normalized) return;
    fs.writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Write deployment choices into .env without touching the API key.
 * @param {string} filePath
 * @param {Record<string, string>} values
 * @returns {boolean}
 */
export function writeEnvValues(filePath, values) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const allowed = new Set([
        'AZURE_OPENAI_DEPLOYMENT',
        'AZURE_OPENAI_DEPLOYMENT_OPUS',
        'AZURE_OPENAI_DEPLOYMENT_SONNET',
        'AZURE_OPENAI_DEPLOYMENT_HAIKU',
        'AZURE_OPENAI_DEPLOYMENT_FABLE'
    ]);
    const original = fs.readFileSync(filePath, 'utf8');
    const lines = original.split(/\r?\n/);
    const seen = new Set();
    const next = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) return line;
        const key = trimmed.slice(0, eq).trim();
        if (!allowed.has(key) || typeof values[key] !== 'string' || values[key] === '') return line;
        seen.add(key);
        return `${key}=${values[key]}`;
    });
    for (const [key, value] of Object.entries(values)) {
        if (!allowed.has(key) || seen.has(key) || typeof value !== 'string' || value === '') continue;
        next.push(`${key}=${value}`);
    }
    const body = `${next.join('\n').replace(/\n+$/, '')}\n`;
    const normalized = original.endsWith('\n') ? original : `${original}\n`;
    if (body === normalized) return false;
    fs.writeFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
    return true;
}

/**
 * @param {string} value
 * @returns {string}
 */
function formatValue(value) {
    if (/[\s#"'\\]/.test(value)) {
        return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }
    return value;
}

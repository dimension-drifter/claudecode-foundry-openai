/**
 * Foundry proxy entry. Loads .env, then listens on 127.0.0.1:8081.
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { prepareLocalEnv } from './load-env.js';
import { createAzureApp } from './providers/azure/app.js';
import { createRedactingLogger } from './providers/azure/redact.js';
import { resolveSettings } from './providers/azure/settings.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prepared = prepareLocalEnv({
    envPath: path.join(root, '.env'),
    examplePath: path.join(root, '.env.example')
});
if (!prepared.ok) {
    console.error(`[foundry] ${prepared.message}`);
    process.exit(1);
}

let settings;
try {
    settings = resolveSettings({ useProcessEnv: true });
} catch (error) {
    console.error(`[foundry] ${error.message}`);
    process.exit(1);
}

const secrets = [settings.azureApiKey, settings.proxyApiKey];
const log = createRedactingLogger(secrets);
const app = createAzureApp({ settings, log, envPath: path.join(root, '.env') });

const server = app.listen(settings.port, settings.host, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : settings.port;
    log.info(`[foundry] listening on http://${settings.host}:${boundPort}`);
    log.info(`[foundry] endpoint ${settings.endpoint}`);
    const modelNames = [settings.defaultDeployment, settings.opus, settings.sonnet, settings.haiku, settings.fable, ...(settings.models || [])].filter(Boolean);
    log.info(`[foundry] deployments ${[...new Set(modelNames)].join(', ') || '(none)'}`);
    log.info(`[foundry] max output tokens ${settings.maxOutputTokens}`);
    log.info(`[foundry] daily token ceiling ${settings.dailyTokenCeiling}`);
    log.info('[foundry] API key auth only');
    log.info(`[foundry] usage page http://127.0.0.1:${boundPort}/`);
});

function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (error) => {
    const message = error instanceof Error ? error.message : 'unhandled rejection';
    log.error('[foundry] unhandled rejection', message);
});

/**
 * Usage files live in ~/.config/foundry-claude-proxy.
 * A previous directory is copied forward once so the token ledger is kept.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

const DATA_DIR_NAME = 'foundry-claude-proxy';
const LEGACY_DATA_DIR_NAME = 'antigravity-proxy-azure';
const USAGE_FILES = ['spend.json', 'requests.json', 'ledger.json'];

/**
 * @param {string} [home]
 * @returns {string}
 */
export function resolveAzureDataDir(home = os.homedir()) {
    const next = path.join(home, '.config', DATA_DIR_NAME);
    const legacy = path.join(home, '.config', LEGACY_DATA_DIR_NAME);
    if (!hasUsage(next) && hasUsage(legacy)) {
        fs.mkdirSync(next, { recursive: true });
        for (const name of USAGE_FILES) {
            const from = path.join(legacy, name);
            const to = path.join(next, name);
            if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
        }
    }
    return next;
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasUsage(dir) {
    return USAGE_FILES.some((name) => fs.existsSync(path.join(dir, name)));
}

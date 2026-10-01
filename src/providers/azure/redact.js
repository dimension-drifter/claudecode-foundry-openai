/**
 * Redact proxy and Azure credentials before they reach logs or error text.
 */

import crypto from 'crypto';

const KEY_PATTERNS = [
    /api-key\s*[:=]\s*"?[^\s"]+"?/gi,
    /authorization\s*[:=]\s*bearer\s+\S+/gi,
    /bearer\s+[A-Za-z0-9._~+/-]{8,}/gi
];

/**
 * @param {unknown} value
 * @param {string[]} secrets
 * @returns {string}
 */
export function redactSecrets(value, secrets = []) {
    let text = String(value ?? '');
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length >= 8) {
            text = text.split(secret).join('[REDACTED]');
        }
    }
    for (const pattern of KEY_PATTERNS) {
        text = text.replace(pattern, (match) => (
            /bearer/i.test(match) ? 'Bearer [REDACTED]' : 'api-key: [REDACTED]'
        ));
    }
    return text;
}

/**
 * Constant-time string compare. Different lengths still run a compare so the
 * missing-key path is not a trivial early return on the secret itself.
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function safeEqualString(left, right) {
    const a = Buffer.from(String(left));
    const b = Buffer.from(String(right));
    if (a.length !== b.length) {
        crypto.timingSafeEqual(a, a);
        return false;
    }
    return crypto.timingSafeEqual(a, b);
}

/**
 * @param {string[]} secrets
 */
export function createRedactingLogger(secrets) {
    const scrub = (args) => args.map((arg) => {
        if (typeof arg === 'string') return redactSecrets(arg, secrets);
        if (arg instanceof Error) return redactSecrets(arg.message, secrets);
        return arg;
    });
    return {
        info: (...args) => console.log(...scrub(args)),
        warn: (...args) => console.warn(...scrub(args)),
        error: (...args) => console.error(...scrub(args))
    };
}

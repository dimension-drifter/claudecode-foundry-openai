/**
 * Map an Azure HTTP error onto the Anthropic error envelope.
 * Response text is redacted before it is returned or logged.
 */

import { redactSecrets } from './redact.js';

/**
 * @param {number} status
 * @returns {{ status: number, type: string }}
 */
export function mapStatus(status) {
    if (status === 400) return { status: 400, type: 'invalid_request_error' };
    if (status === 401) return { status: 401, type: 'authentication_error' };
    if (status === 403) return { status: 403, type: 'permission_error' };
    if (status === 404) return { status: 404, type: 'not_found_error' };
    if (status === 429) return { status: 429, type: 'rate_limit_error' };
    return { status: 502, type: 'api_error' };
}

/**
 * @param {string} type
 * @param {string} message
 */
export function anthropicError(type, message) {
    return {
        type: 'error',
        error: { type, message }
    };
}

/**
 * @param {string} text
 * @returns {string}
 */
function extractMessage(text) {
    if (!text) return '';
    try {
        const parsed = JSON.parse(text);
        const message = parsed?.error?.message || parsed?.message;
        if (typeof message === 'string' && message) return message.slice(0, 500);
    } catch {
        // Fall through to a clipped plain-text message.
    }
    return text.slice(0, 500);
}

/**
 * @param {Response} response
 * @param {string[]} secrets
 */
export async function readAzureError(response, secrets) {
    let text = '';
    try {
        text = await response.text();
    } catch {
        text = '';
    }
    const mapped = mapStatus(response.status);
    const message = redactSecrets(extractMessage(text), secrets) || 'Azure request failed';
    return {
        status: mapped.status,
        body: anthropicError(mapped.type, message)
    };
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
    return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR'));
}

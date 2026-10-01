/**
 * HTTPS client for one allowlisted Azure host.
 * Redirects are errors so the api-key header cannot be forwarded.
 */

import { assertSafeAzureUrl, chatCompletionsUrl, responsesUrl } from './endpoint.js';

/**
 * @param {{
 *   endpoint: string,
 *   apiKey: string,
 *   allowHosts: string[],
 *   allowHttpLoopback?: boolean,
 *   fetchImpl?: typeof fetch
 * }} options
 */
export function createAzureClient(options) {
    const endpoint = assertSafeAzureUrl(options.endpoint, {
        allowHosts: options.allowHosts,
        allowHttpLoopback: options.allowHttpLoopback === true
    });
    const url = chatCompletionsUrl(endpoint);
    const fetchImpl = options.fetchImpl || fetch;

    return {
        url,
        /**
         * @param {object} payload
         * @param {{ signal?: AbortSignal }} call
         */
        complete(payload, call = {}) {
            return fetchImpl(call.api === 'responses' ? responsesUrl(endpoint) : url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': options.apiKey
                },
                body: JSON.stringify(payload),
                redirect: 'error',
                cache: 'no-store',
                signal: call.signal
            });
        }
    };
}

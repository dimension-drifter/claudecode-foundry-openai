/**
 * Allow only an explicit HTTPS host. Query strings, fragments, and
 * credential userinfo are rejected so the API key cannot be attached to a URL
 * or forwarded to another host.
 */

/**
 * @param {string} endpoint
 * @param {{ allowHosts: string[], allowHttpLoopback?: boolean }} options
 * @returns {string} Endpoint with no trailing slash
 */
export function assertSafeAzureUrl(endpoint, options) {
    let url;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error('Azure endpoint is not a valid URL');
    }

    if (url.username || url.password) {
        throw new Error('Azure endpoint must not include credentials');
    }
    if (url.search || url.hash) {
        throw new Error('Azure endpoint must not include a query or fragment');
    }

    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol === 'https:') {
        if (url.port && url.port !== '443') {
            throw new Error('Azure endpoint must use port 443');
        }
        if (!options.allowHosts.includes(url.hostname)) {
            throw new Error('Azure endpoint host is not allowlisted');
        }
    } else if (options.allowHttpLoopback === true && url.protocol === 'http:' && loopback) {
        // Unit tests talk to a local mock. The real entrypoint never sets this.
    } else {
        throw new Error('Azure endpoint must be https');
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path !== '/openai/v1') {
        throw new Error('Azure endpoint path must be /openai/v1');
    }

    return `${url.protocol}//${url.host}${path}`;
}

/**
 * @param {string} endpoint normalized endpoint
 * @returns {string}
 */
export function chatCompletionsUrl(endpoint) {
    return `${endpoint.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * @param {string} endpoint normalized endpoint
 * @returns {string}
 */
export function responsesUrl(endpoint) {
    return `${endpoint.replace(/\/+$/, '')}/responses`;
}

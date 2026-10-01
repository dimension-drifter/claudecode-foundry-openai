/**
 * Read an Azure SSE body without following anything else.
 */

/**
 * @param {Response} response
 * @returns {AsyncGenerator<object>}
 */
export async function* readSseJson(response) {
    if (!response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newline = buffer.indexOf('\n');
            while (newline >= 0) {
                const line = buffer.slice(0, newline).replace(/\r$/, '');
                buffer = buffer.slice(newline + 1);
                newline = buffer.indexOf('\n');
                if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data) continue;
                if (data === '[DONE]') return;
                try {
                    yield JSON.parse(data);
                } catch {
                    throw new Error('Azure stream sent invalid JSON');
                }
            }
        }
    } finally {
        try {
            await reader.cancel();
        } catch {
            // The caller already stopped reading.
        }
    }
}

/**
 * USD list rates per 1,000,000 tokens, stored as micro-dollars
 * (1 USD = 1,000,000). Figures are the OpenAI Standard card for
 * gpt-6-luna, gpt-6.1-sol, gpt-6-sol, and gpt-6-astra. Azure Global
 * Standard meters published for gpt-6-luna match that card.
 *
 * A request whose input exceeds 272,000 tokens uses the long rates for
 * every token in that request. Cache-write tokens use the write rate
 * instead of the fresh-input rate. Reasoning tokens are already inside
 * output and are not priced again.
 */

export const LONG_CONTEXT_INPUT_TOKENS = 272000;
const PER_MILLION = 1000000n;

const CARDS = {
    'gpt-6-luna': {
        short: { fresh: 100000n, cached: 10000n, write: 125000n, output: 500000n },
        long: { fresh: 200000n, cached: 20000n, write: 250000n, output: 750000n }
    },
    'gpt-6.1-sol': {
        short: { fresh: 2000000n, cached: 100000n, write: 2500000n, output: 10000000n },
        long: { fresh: 4000000n, cached: 200000n, write: 5000000n, output: 15000000n }
    },
    'gpt-6-sol': {
        short: { fresh: 2000000n, cached: 200000n, write: 2500000n, output: 10000000n },
        long: { fresh: 4000000n, cached: 400000n, write: 5000000n, output: 15000000n }
    },
    'gpt-6-astra': {
        short: { fresh: 10000000n, cached: 1000000n, write: 12500000n, output: 50000000n },
        long: { fresh: 20000000n, cached: 2000000n, write: 25000000n, output: 75000000n }
    }
};

/**
 * @param {string} deployment
 * @returns {string}
 */
export function rateKey(deployment) {
    const name = String(deployment || '').toLowerCase();
    if (name.includes('gpt-6.1-sol') || name.includes('gpt-6-1-sol')) return 'gpt-6.1-sol';
    if (name.includes('gpt-6-astra')) return 'gpt-6-astra';
    if (name.includes('gpt-6-sol')) return 'gpt-6-sol';
    if (name.includes('gpt-6-luna')) return 'gpt-6-luna';
    return '';
}

/**
 * @param {number} promptTokens
 * @returns {'short'|'long'}
 */
export function contextLane(promptTokens) {
    return promptTokens > LONG_CONTEXT_INPUT_TOKENS ? 'long' : 'short';
}

/**
 * @param {string} key
 * @param {'short'|'long'} lane
 * @param {{ fresh: number, cached: number, write: number, output: number }} bucket
 * @returns {bigint|null}
 */
export function bucketMicros(key, lane, bucket) {
    const card = CARDS[key];
    if (!card) return null;
    const rate = card[lane];
    const fresh = BigInt(bucket.fresh || 0);
    const cached = BigInt(bucket.cached || 0);
    const write = BigInt(bucket.write || 0);
    const output = BigInt(bucket.output || 0);
    return (fresh * rate.fresh + cached * rate.cached + write * rate.write + output * rate.output) / PER_MILLION;
}

/**
 * @param {bigint} micros
 * @returns {string}
 */
export function formatMicros(micros) {
    const n = typeof micros === 'bigint' ? micros : BigInt(micros);
    const neg = n < 0n;
    const v = neg ? -n : n;
    const whole = v / PER_MILLION;
    const frac = (v % PER_MILLION).toString().padStart(6, '0');
    return `${neg ? '-' : ''}${whole}.${frac}`;
}

/**
 * @param {bigint} microsPerMillion
 * @returns {string}
 */
function formatRate(microsPerMillion) {
    const whole = microsPerMillion / PER_MILLION;
    let frac = (microsPerMillion % PER_MILLION).toString().padStart(6, '0').replace(/0+$/, '');
    if (frac.length < 2) frac = frac.padEnd(2, '0');
    return `${whole}.${frac}`;
}

/**
 * @returns {object[]}
 */
export function publishedRates() {
    return Object.entries(CARDS).map(([model, card]) => ({
        model,
        unit: 'USD per 1,000,000 tokens',
        short: {
            fresh: formatRate(card.short.fresh),
            cached: formatRate(card.short.cached),
            write: formatRate(card.short.write),
            output: formatRate(card.short.output)
        },
        long: {
            fresh: formatRate(card.long.fresh),
            cached: formatRate(card.long.cached),
            write: formatRate(card.long.write),
            output: formatRate(card.long.output)
        }
    }));
}

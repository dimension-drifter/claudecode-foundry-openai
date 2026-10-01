/**
 * Per-day token ledger for the cost tab. Stores counts only.
 * The calendar is UTC. A month runs from the 1st through the last day.
 */

import fs from 'fs';
import path from 'path';
import { Mutex } from 'async-mutex';
import { bucketMicros, contextLane, formatMicros, LONG_CONTEXT_INPUT_TOKENS, publishedRates, rateKey } from './pricing.js';

const MAX_SEEN = 2000;

export class UsageLedger {
    /**
     * @param {string} filePath
     */
    constructor(filePath) {
        if (!filePath) throw new Error('Ledger file path is required');
        this.filePath = filePath;
        this.mutex = new Mutex();
        this.state = this.#load();
    }

    #load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
            const days = Object.create(null);
            if (parsed && parsed.days && typeof parsed.days === 'object') {
                for (const [day, deployments] of Object.entries(parsed.days)) {
                    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !deployments || typeof deployments !== 'object') continue;
                    const clean = Object.create(null);
                    for (const [name, lanes] of Object.entries(deployments)) {
                        if (!lanes || typeof lanes !== 'object') continue;
                        clean[String(name).slice(0, 120)] = {
                            short: lane(lanes.short),
                            long: lane(lanes.long)
                        };
                    }
                    days[day] = clean;
                }
            }
            const seen = Array.isArray(parsed?.seen)
                ? parsed.seen.filter((id) => typeof id === 'string').slice(-MAX_SEEN)
                : [];
            return { days, seen };
        } catch {
            return { days: Object.create(null), seen: [] };
        }
    }

    #persist() {
        const days = {};
        for (const [day, deployments] of Object.entries(this.state.days)) days[day] = deployments;
        const body = JSON.stringify({ days, seen: this.state.seen });
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
        try {
            if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath, { force: true });
            fs.renameSync(tmp, this.filePath);
        } catch {
            fs.writeFileSync(this.filePath, body, { encoding: 'utf8', mode: 0o600 });
            fs.rmSync(tmp, { force: true });
        }
    }

    /**
     * @param {object[]} rows
     */
    backfill(rows) {
        let changed = false;
        for (const row of rows || []) {
            if (this.#absorb(row)) changed = true;
        }
        if (changed) this.#persist();
    }

    /**
     * @param {object} row
     */
    async apply(row) {
        await this.mutex.runExclusive(() => {
            if (this.#absorb(row)) this.#persist();
        });
    }

    /**
     * @param {string} day UTC date YYYY-MM-DD
     */
    summary(day) {
        const bounds = monthBounds(day);
        const monthKeys = bounds.keys.filter((key) => key <= day);
        return {
            timeZone: 'UTC',
            day,
            month: bounds.month,
            monthStart: bounds.start,
            monthEnd: bounds.end,
            threshold: LONG_CONTEXT_INPUT_TOKENS,
            currency: 'USD',
            rates: publishedRates(),
            today: priceDays(this.state.days, [day]),
            month: priceDays(this.state.days, monthKeys),
            days: bounds.keys.map((key) => {
                if (key > day) {
                    return emptyDay(key);
                }
                const statement = priceDays(this.state.days, [key]);
                return {
                    day: key,
                    micros: statement.micros,
                    usd: statement.usd,
                    requests: statement.requests,
                    totalTokens: statement.totalTokens,
                    fresh: statement.fresh,
                    cached: statement.cached,
                    write: statement.write,
                    output: statement.output
                };
            })
        };
    }

    /**
     * @param {object} row
     * @returns {boolean} true when this id was new
     */
    #absorb(row) {
        const id = typeof row?.id === 'string' ? row.id : '';
        if (!id || this.state.seen.includes(id)) return false;
        this.state.seen.push(id);
        if (this.state.seen.length > MAX_SEEN) {
            this.state.seen.splice(0, this.state.seen.length - MAX_SEEN);
        }
        if (!billable(row)) return true;
        const meters = metersFromRow(row);
        const day = utcDay(row.at);
        const name = deploymentName(row.deployment);
        const laneName = contextLane(meters.prompt);
        if (!this.state.days[day]) this.state.days[day] = Object.create(null);
        if (!this.state.days[day][name]) {
            this.state.days[day][name] = { short: emptyLane(), long: emptyLane() };
        }
        const bucket = this.state.days[day][name][laneName];
        bucket.fresh += meters.fresh;
        bucket.cached += meters.cached;
        bucket.write += meters.write;
        bucket.output += meters.output;
        bucket.reasoning += meters.reasoning;
        bucket.requests += 1;
        bucket.total += meters.total;
        return true;
    }
}

function emptyDay(key) {
    return {
        day: key,
        micros: '0',
        usd: formatMicros(0n),
        requests: 0,
        totalTokens: 0,
        fresh: 0,
        cached: 0,
        write: 0,
        output: 0
    };
}

/**
 * @param {object|undefined} value
 */
function lane(value) {
    return {
        fresh: n(value?.fresh),
        cached: n(value?.cached),
        write: n(value?.write),
        output: n(value?.output),
        reasoning: n(value?.reasoning),
        requests: n(value?.requests),
        total: n(value?.total)
    };
}

function emptyLane() {
    return lane(null);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function n(value) {
    const x = Number(value);
    if (!Number.isFinite(x) || x <= 0) return 0;
    return Math.floor(x);
}

/**
 * @param {object} row
 */
function billable(row) {
    const status = Number(row.status);
    if (n(row.totalTokens) > 0) return true;
    return status >= 200 && status < 300;
}

/**
 * @param {object} row
 */
function metersFromRow(row) {
    const write = n(row.cacheWriteTokens);
    const cached = n(row.cachedTokens);
    const fresh = row.freshTokens == null ? Math.max(0, n(row.inputTokens) - write) : n(row.freshTokens);
    const output = n(row.outputTokens);
    const reasoning = Math.min(n(row.reasoningTokens), output);
    const prompt = row.promptTokens == null ? fresh + cached + write : n(row.promptTokens);
    return {
        fresh,
        cached,
        write,
        output,
        reasoning,
        prompt,
        total: n(row.totalTokens)
    };
}

/**
 * @param {string} at
 * @returns {string}
 */
function utcDay(at) {
    const date = new Date(at);
    if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
    return date.toISOString().slice(0, 10);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function deploymentName(value) {
    const name = String(value || 'unknown').slice(0, 120);
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') return 'unknown';
    return name;
}

/**
 * @param {string} day
 */
function monthBounds(day) {
    const [year, month] = day.split('-').map(Number);
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const stamp = day.slice(0, 7);
    const keys = [];
    for (let date = 1; date <= last; date += 1) {
        keys.push(`${stamp}-${String(date).padStart(2, '0')}`);
    }
    return { month: stamp, start: keys[0], end: keys[keys.length - 1], keys };
}

/**
 * @param {object} days
 * @param {string[]} keys
 */
function priceDays(days, keys) {
    /** @type {Map<string, { deployment: string, lane: string, fresh: number, cached: number, write: number, output: number, reasoning: number, requests: number, total: number }>} */
    const groups = new Map();
    for (const key of keys) {
        const deployments = days[key];
        if (!deployments) continue;
        for (const [deployment, lanes] of Object.entries(deployments)) {
            for (const laneName of ['short', 'long']) {
                const bucket = lanes[laneName];
                if (!bucket || bucket.requests <= 0) continue;
                const id = `${deployment}\n${laneName}`;
                const current = groups.get(id) || {
                    deployment,
                    lane: laneName,
                    fresh: 0,
                    cached: 0,
                    write: 0,
                    output: 0,
                    reasoning: 0,
                    requests: 0,
                    total: 0
                };
                current.fresh += bucket.fresh;
                current.cached += bucket.cached;
                current.write += bucket.write;
                current.output += bucket.output;
                current.reasoning += bucket.reasoning;
                current.requests += bucket.requests;
                current.total += bucket.total;
                groups.set(id, current);
            }
        }
    }

    const deployments = [];
    const unpriced = [];
    let micros = 0n;
    let requests = 0;
    let fresh = 0;
    let cached = 0;
    let write = 0;
    let output = 0;
    let reasoning = 0;
    let totalTokens = 0;
    for (const group of groups.values()) {
        requests += group.requests;
        fresh += group.fresh;
        cached += group.cached;
        write += group.write;
        output += group.output;
        reasoning += group.reasoning;
        totalTokens += group.total;
        const key = rateKey(group.deployment);
        const priced = key ? bucketMicros(key, group.lane, group) : null;
        const row = {
            deployment: group.deployment,
            lane: group.lane,
            requests: group.requests,
            fresh: group.fresh,
            cached: group.cached,
            write: group.write,
            output: group.output,
            reasoning: group.reasoning,
            totalTokens: group.total
        };
        if (priced == null) {
            unpriced.push({ ...row, priced: false });
            continue;
        }
        micros += priced;
        deployments.push({ ...row, priced: true, pricedMicros: priced });
    }
    deployments.sort((a, b) => (
        a.pricedMicros > b.pricedMicros ? -1
            : a.pricedMicros < b.pricedMicros ? 1
                : a.deployment.localeCompare(b.deployment)
    ));
    for (const row of deployments) {
        row.micros = microsToString(row.pricedMicros);
        row.usd = formatMicros(row.pricedMicros);
        delete row.pricedMicros;
    }
    unpriced.sort((a, b) => b.totalTokens - a.totalTokens || a.deployment.localeCompare(b.deployment));
    const pricedRequests = deployments.reduce((sum, row) => sum + row.requests, 0);
    return {
        micros: microsToString(micros),
        usd: formatMicros(micros),
        priced: pricedRequests > 0 || requests === 0,
        requests,
        fresh,
        cached,
        write,
        output,
        reasoning,
        totalTokens,
        deployments,
        unpriced
    };
}

/**
 * @param {bigint} micros
 * @returns {string}
 */
function microsToString(micros) {
    return micros.toString();
}

// @typecheck
/**
 * The Fireflies GraphQL transport and input rules: errors shown to the caller
 * are fixed sentences (an upstream body or message can carry personal data),
 * list filters are validated before a request leaves, durations are readable.
 */
const log = require('../telemetry/log');

const FIREFLIES_API_URL = 'https://api.fireflies.ai/graphql';

/** An error whose message is safe to show the caller (it never carries an upstream body). */
class FirefliesError extends Error {}

/** @param {number} status */
function messageForStatus(status) {
    if (status === 401 || status === 403) return 'Fireflies rejected the API key. Check the key in Admin → AI Config → API Keys.';
    if (status === 429) return 'Fireflies rate limit reached. Try again in a minute.';
    if (status >= 500) return 'Fireflies is temporarily unavailable. Try again later.';
    return `Fireflies could not handle the request (status ${status}).`;
}

/**
 * @param {string} apiKey
 * @param {string} query
 * @param {Record<string, unknown>} [variables]
 * @returns {Promise<any>} the GraphQL `data`
 */
async function firefliesRequest(apiKey, query, variables = {}) {
    let response;
    try {
        response = await fetch(FIREFLIES_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ query, variables }),
        });
    } catch (err) {
        log.warn('[Fireflies] request failed:', err.message);
        throw new FirefliesError('Fireflies could not be reached. Try again later.');
    }

    // Upstream bodies and GraphQL messages can carry personal data: log the
    // status, show the caller a fixed sentence.
    if (!response.ok) {
        log.warn(`[Fireflies] API answered ${response.status}`);
        throw new FirefliesError(messageForStatus(response.status));
    }

    /** @type {{ data?: any, errors?: unknown[] }} */
    const json = await response.json();

    if (json.errors) {
        log.warn(`[Fireflies] GraphQL answered with ${json.errors.length} error(s)`);
        throw new FirefliesError('Fireflies rejected the request. Check the transcript id and the filters.');
    }

    return json.data;
}

/**
 * Minutes as the caller reads them: whole minutes, "<1 min" below one.
 * @param {unknown} minutes
 */
function formatDuration(minutes) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0) return 'unknown';
    return m < 0.5 ? '<1 min' : `${Math.round(m)} min`;
}

/**
 * Validate the list filters before they reach Fireflies.
 * @param {Record<string, any>} args
 * @returns {{ error: string } | { skip: number, fromDate: string|null, toDate: string|null }}
 */
function parseListFilters(args) {
    let skip = 0;
    if (args.skip !== undefined && args.skip !== null && args.skip !== '') {
        skip = Number(args.skip);
        if (!Number.isInteger(skip) || skip < 0) return { error: 'skip must be a whole number of 0 or more.' };
    }
    /** @type {Record<string, string|null>} */
    const dates = { fromDate: null, toDate: null };
    for (const key of ['fromDate', 'toDate']) {
        const raw = args[key];
        if (raw === undefined || raw === null || raw === '') continue;
        const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
        if (Number.isNaN(ms)) return { error: `${key} must be a date like 2025-01-31 or 2025-01-31T09:00:00Z.` };
        dates[key] = new Date(ms).toISOString();
    }
    if (dates.fromDate && dates.toDate && dates.fromDate > dates.toDate) {
        return { error: 'fromDate must not be later than toDate.' };
    }
    return { skip, fromDate: dates.fromDate, toDate: dates.toDate };
}

module.exports = { FirefliesError, firefliesRequest, formatDuration, parseListFilters };

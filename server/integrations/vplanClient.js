// @typecheck
const { DEFAULT_LIMIT, MAX_LIMIT } = require('./vplanToolDefs');
const { fallback: fallbackSwallowed } = require('../utils/bestEffort');

const API_BASE = 'https://api.vplan.com/v1';

const REQUEST_TIMEOUT_MS = 20000;

const MAX_RESPONSE_CHARS = 30000;

const MAX_ERROR_MESSAGE_CHARS = 300;

const RETRY_AFTER_CAP_MS = 5000;

// Long opaque strings that carry no meaning for the model and cost a lot of
// context. Stripped from every response.
const NOISE_KEY_RE = /_(checksum|signature)$/;

function clampLimit(raw, fallback = DEFAULT_LIMIT) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function clampOffset(raw) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Drop trailing rows until the serialized result fits the LLM-context budget.
 * Never truncates mid-row. (Mirrors afasTools/nmbrsTools.truncateRows.)
 */
function truncateRows(rows, maxChars = MAX_RESPONSE_CHARS) {
    if (!Array.isArray(rows)) return { rows: [], truncated: false };
    let kept = rows;
    let truncated = false;
    while (kept.length > 1 && JSON.stringify(kept).length > maxChars) {
        kept = kept.slice(0, Math.floor(kept.length / 2));
        truncated = true;
    }
    if (kept.length > 0 && JSON.stringify(kept).length > maxChars) {
        // Even a single row blows the budget — drop it rather than flood the context.
        kept = [];
        truncated = true;
    }
    return { rows: kept, truncated };
}

/**
 * Strip checksum/signature blobs from a response. They are long, opaque and
 * useless to the model. Recurses into nested objects and arrays.
 */
function stripNoise(value, depth = 0) {
    if (Array.isArray(value)) {
        return depth > 4 ? value : value.map(v => stripNoise(v, depth + 1));
    }
    if (!value || typeof value !== 'object') return value;
    if (depth > 4) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        if (NOISE_KEY_RE.test(k)) continue;
        out[k] = stripNoise(v, depth + 1);
    }
    return out;
}

/**
 * Extract a short, sanitized message from a vPlan error body. vPlan returns
 * `{ reference, errors: [{ code, message, description, ... }] }`. Only the
 * human-readable text is surfaced — never the raw body and never the request
 * URL (it carries the filter values, which are customer data).
 */
function extractVplanErrorMessage(bodyText) {
    if (!bodyText || typeof bodyText !== 'string') return null;
    let message = null;
    if (bodyText.trim().startsWith('{')) {
        try {
            const data = JSON.parse(bodyText);
            const first = Array.isArray(data.errors) ? data.errors[0] : null;
            message = (first && (first.description || first.message))
                || data.message
                || (data.error && data.error.message)
                || null;
        } catch (err) { fallbackSwallowed('integrations/vplanClient:extractVplanErrorMessage', err); /* not JSON after all */ }
    }
    if (!message) return null;
    return String(message).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_MESSAGE_CHARS) || null;
}

const STATUS_REASONS = {
    400: 'vPlan rejected the request (check the filter fields and values)',
    401: 'the vPlan API key or environment is invalid or has been revoked',
    403: 'this vPlan API key is not allowed to read that data',
    404: 'not found in this vPlan environment',
    422: 'vPlan could not process the request',
    429: 'the vPlan API rate limit was reached — try again shortly',
};

const MAINTENANCE_MESSAGE = 'vPlan is temporarily unavailable (maintenance or a release) — try again later.';

/**
 * Milliseconds to wait before retrying a rate-limited request, from the
 * RateLimit-Reset header (seconds). Capped so a hostile or broken value cannot
 * stall the agent loop.
 */
function retryDelayMs(headers) {
    const raw = headers && typeof headers.get === 'function' ? headers.get('RateLimit-Reset') : null;
    const seconds = parseInt(raw, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return 1000;
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
}

function sleep(ms) {
    return new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        if (typeof t.unref === 'function') t.unref();
    });
}

function buildUrl(path, query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query || {})) {
        if (v === undefined || v === null || v === '') continue;
        params.set(k, String(v));
    }
    const qs = params.toString();
    return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

async function vplanFetch(creds, url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    if (typeof timeout.unref === 'function') timeout.unref();
    try {
        return await fetch(url, {
            method: 'GET',
            headers: {
                'X-Api-Key': creds.apiKey,
                'X-Api-Env': creds.apiEnv,
                Accept: 'application/json',
            },
            // vPlan uses HTTP 303 to redirect to an HTML maintenance page and the
            // docs say not to follow it — following would yield a 200 full of HTML.
            redirect: 'manual',
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
}

async function vplanRequest(creds, path, /** @type {Record<string, string | undefined> | null} */ query = null, retried = false) {
    const url = buildUrl(path, query);

    let response;
    try {
        response = await vplanFetch(creds, url);
    } catch (err) {
        if (err && err.name === 'AbortError') {
            throw new Error(`vPlan request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`);
        }
        // Never surface the URL — it carries the filter values.
        throw new Error('Could not reach vPlan.');
    }

    if (response.status === 303 || response.status === 503) {
        throw new Error(MAINTENANCE_MESSAGE);
    }

    if (response.status === 429 && !retried) {
        await sleep(retryDelayMs(response.headers));
        return vplanRequest(creds, path, query, true);
    }

    if (!response.ok) {
        const reason = STATUS_REASONS[response.status] || `vPlan returned HTTP ${response.status}`;
        let detail = null;
        try {
            detail = extractVplanErrorMessage(await response.text());
        } catch (err) { fallbackSwallowed('integrations/vplanClient:vplanRequest', err); /* body unreadable — keep the mapped reason */ }
        throw new Error(detail ? `${reason}: ${detail}` : reason);
    }

    try {
        return stripNoise(await response.json());
    } catch {
        throw new Error('vPlan returned an unexpected non-JSON response.');
    }
}

/**
 * Run a paginated GET and shape it into the envelope the tools return:
 * the (possibly truncated) rows plus enough metadata for the model to page on.
 */
async function vplanList(creds, path, query) {
    const payload = await vplanRequest(creds, path, query);
    const all = (payload && Array.isArray(payload.data)) ? payload.data : [];
    const { rows, truncated } = truncateRows(all);
    const limit = clampLimit(query && query.limit);
    const offset = clampOffset(query && query.offset);
    const total = (payload && Number.isFinite(payload.count)) ? payload.count : null;

    const result = { data: rows, count: rows.length, offset, limit };
    if (total !== null) {
        result.total = total;
        result.hasMore = offset + all.length < total;
    } else {
        result.hasMore = all.length === limit;
    }
    if (truncated) {
        result.truncated = true;
        result.message = `Response too large — showing ${rows.length} of ${all.length} fetched records. Narrow with filters, request fewer related objects, or lower limit.`;
    }
    return result;
}

module.exports = { clampLimit, clampOffset, truncateRows, stripNoise, extractVplanErrorMessage, retryDelayMs, buildUrl, vplanRequest, vplanList };

/**
 * vPlan Tools — read-only access to a vPlan planning environment.
 *
 * vPlan (app.vplan.com) is a planning/work-preparation platform: boards with
 * stages, collections (jobs) that get planned into cards, resources with
 * schedules, orders, and time tracking. This module exposes GET endpoints only —
 * every request is a GET and the tool set contains no create/update/delete
 * operations by design (vplanTools.test.js asserts both).
 *
 * Auth is a per-user API key pair (X-Api-Key + X-Api-Env), both copied from
 * vPlan → Settings → Developers → API keys. The base URL is a fixed constant,
 * so unlike AFAS/YouTrack there is no user-controlled host and no SSRF surface;
 * the only injection vector is CR/LF into the two headers, which the credential
 * regexes below reject.
 *
 * The request helper is local rather than shared/apiClient.jsonApiRequest for
 * two reasons the shared helper cannot express:
 *   - vPlan answers HTTP 303 with a redirect to an HTML maintenance page, and
 *     the API docs say explicitly not to follow it (following it hands the model
 *     a 200 full of HTML instead of JSON) — so every fetch uses redirect:'manual'.
 *   - The RateLimit-* response headers drive the single 429 retry.
 * Uses raw REST — no npm dependencies.
 *
 * API reference: https://docs.api.vplan.com/
 */

const configStore = require('../stores/configStore');
const log = require('../telemetry/log');

const API_BASE = 'https://api.vplan.com/v1';
const REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_LIMIT = 25;
// vPlan allows up to 1000, but a large page blows the model's context budget and
// is the documented cause of vPlan's own "memory exhausted" (10005) error.
const MAX_LIMIT = 100;
const MAX_RESPONSE_CHARS = 30000;
const MAX_ERROR_MESSAGE_CHARS = 300;
const RETRY_AFTER_CAP_MS = 5000;

// Both credentials travel in request headers, so these regexes are the
// header-injection guard: no whitespace, no CR, no LF.
const API_KEY_RE = /^[A-Za-z0-9._~-]{16,512}$/;
const API_ENV_RE = /^[A-Za-z0-9._~-]{4,128}$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// vPlan filter operators (docs.api.vplan.com/filtering).
const FILTER_OPERATORS = new Set([
    'eq', 'not', 'gt', 'gte', 'lt', 'lte', 'has', 'contains', 'starts_with', 'ends_with',
]);

// Allowed first-layer `with` (eager loading) values per endpoint. Anything the
// model invents is dropped rather than forwarded, so a typo never 400s the call.
const WITH_OPTIONS = {
    board: ['stages', 'collections', 'cards'],
    activity: ['time_tracking', 'stages'],
    resource: ['activities', 'cards', 'resources', 'schedules'],
    collection: ['activities', 'attachments', 'cards', 'checklists', 'comments', 'followers', 'labels', 'order'],
    // `statuses` is listed in vPlan's own docs for the card endpoint but the live
    // API rejects it with "Relation not found: statuses" — dropped deliberately.
    // The status is already on the card as `status_id`, and the readable status
    // objects come with the board (vplan_list_boards).
    card: ['activities', 'collection', 'labels', 'resources', 'stage', 'time', 'time_tracking', 'relations'],
    order: ['orderRows', 'item', 'relation'],
    group: ['resources'],
    user: ['resource', 'time_tracking', 'settings', 'board_views'],
    space: ['boards'],
};

// Master-data endpoints that are thin enough to share one tool.
const MASTER_DATA_TYPES = {
    project:   { path: '/project' },
    item:      { path: '/item' },
    relation:  { path: '/relation' },
    warehouse: { path: '/warehouse' },
    user:      { path: '/user',  withKey: 'user',  supportsArchived: true },
    group:     { path: '/group', withKey: 'group' },
    space:     { path: '/space', withKey: 'space' },
};

// Capacity scope → path suffix under /board/{board_id}/capacity.
const CAPACITY_SCOPES = {
    stage: 'stage',
    resource: 'resource',
    group: 'group',
    resource_type: 'resource_type/stage',
};

const TIME_FRAMES = ['day', 'week', 'month', 'quarter', 'year'];

const TIME_TRACKING_GROUP_BY = [
    'days', 'weeks', 'activities', 'collections', 'boards', 'statuses', 'users',
];

// Long opaque strings that carry no meaning for the model and cost a lot of
// context. Stripped from every response.
const NOISE_KEY_RE = /_(checksum|signature)$/;

// ─── Tool definitions (OpenAI function-calling format) ─────────

const FILTER_PARAM = {
    type: 'array',
    description: 'Optional filters, combined with AND. Use snake_case field names from the objects this tool returns (e.g. start_date, status, updated_at). Dates are YYYY-MM-DD, timestamps ISO-8601.',
    items: {
        type: 'object',
        properties: {
            field: { type: 'string', description: 'Field to filter on' },
            operator: { type: 'string', description: 'One of: eq, not, gt, gte, lt, lte, has, contains, starts_with, ends_with (default: eq)' },
            value: { type: 'string', description: 'Value to compare against. May not contain a single quote.' },
        },
        required: ['field', 'value'],
    },
};

const SORT_PARAM = {
    type: 'array',
    description: 'Optional sort order. Only works on main fields of the object, not on eager-loaded ones.',
    items: {
        type: 'object',
        properties: {
            field: { type: 'string', description: 'Field to sort on' },
            direction: { type: 'string', description: '"asc" (default) or "desc"' },
        },
        required: ['field'],
    },
};

/**
 * Build the shared parameter schema for a list tool: pagination + filter + sort,
 * plus an optional `with` enum and any tool-specific extras.
 */
function listParams(withKey, extra = {}, required = []) {
    const properties = {
        limit: { type: 'integer', description: `Maximum number of records (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})` },
        offset: { type: 'integer', description: 'Pagination offset (default 0)' },
        filters: FILTER_PARAM,
        sort: SORT_PARAM,
        ...extra,
    };
    if (withKey && WITH_OPTIONS[withKey]) {
        properties.with = {
            type: 'array',
            description: 'Related objects to include in the response. Only request what you need — large payloads get truncated.',
            items: { type: 'string', enum: WITH_OPTIONS[withKey] },
        };
    }
    return { type: 'object', properties, required };
}

function fn(name, description, parameters) {
    return { type: 'function', function: { name, description, parameters } };
}

const VPLAN_TOOLS = [
    fn(
        'vplan_whoami',
        'Show which vPlan environment the current API key is connected to: customer name, environment status, enabled features and permissions. Use this to confirm the connection works or to tell the user which vPlan account is linked.',
        { type: 'object', properties: {}, required: [] },
    ),
    fn(
        'vplan_list_boards',
        'List the vPlan planning boards. ALWAYS call this first when you need to work with cards, stages, statuses, labels or capacity — the board object carries the stage IDs, status IDs, label IDs and custom-field definitions that the other vPlan tools need. Never guess these IDs.',
        listParams('board', {
            boardId: { type: 'string', description: 'Optional: fetch one board by id instead of the list' },
        }),
    ),
    fn(
        'vplan_list_resources',
        'List the vPlan resources — the plannable employees, machines and cells, with their working hours per weekday. Use this to find resource IDs before asking for availability or capacity.',
        listParams('resource', {
            resourceId: { type: 'string', description: 'Optional: fetch one resource by id instead of the list' },
            archived: { type: 'boolean', description: 'Include archived resources (default false)' },
        }),
    ),
    fn(
        'vplan_get_resource_availability',
        'Get the day-by-day schedule of one vPlan resource over a date range: hours available, hours of planned work, hours of leave and hours of absence — plus the absences (leave, holiday, maintenance, malfunction, …) that overlap the range. Use this to answer "who is available when".',
        {
            type: 'object',
            properties: {
                resourceId: { type: 'string', description: 'Resource id from vplan_list_resources' },
                start: { type: 'string', description: 'Start of the range, YYYY-MM-DD' },
                end: { type: 'string', description: 'End of the range, YYYY-MM-DD' },
                includeAbsences: { type: 'boolean', description: 'Also return the absences overlapping the range (default true)' },
                limit: { type: 'integer', description: `Maximum number of days (1-${MAX_LIMIT}, default ${MAX_LIMIT})` },
                offset: { type: 'integer', description: 'Pagination offset (default 0)' },
            },
            required: ['resourceId', 'start', 'end'],
        },
    ),
    fn(
        'vplan_list_activities',
        'List the vPlan activities — the services or operations that can be planned (with their resource type, default duration, billable flag and hourly rate). Activity IDs are needed to read time tracking per activity.',
        listParams('activity', {
            activityId: { type: 'string', description: 'Optional: fetch one activity by id instead of the list' },
        }),
    ),
    fn(
        'vplan_list_collections',
        'List vPlan collections — the jobs, orders or projects that are planned (or waiting in the backlog). Each collection holds one or more cards once planned. Filter on status (planned/not_planned/ignored), progress (open/partial/done), due_date, board_id or updated_at.',
        listParams('collection', {
            boardId: { type: 'string', description: 'Optional: only collections on this board' },
        }),
    ),
    fn(
        'vplan_get_collection',
        'Get one vPlan collection in full, optionally with its cards, attachments, comments and checklists. Use this when the user asks about a specific job/order and you need the detail rather than a list.',
        {
            type: 'object',
            properties: {
                collectionId: { type: 'string', description: 'Collection id from vplan_list_collections' },
                include: {
                    type: 'array',
                    description: 'Extra detail to fetch alongside the collection.',
                    items: { type: 'string', enum: ['cards', 'attachments', 'comments', 'checklists'] },
                },
            },
            required: ['collectionId'],
        },
    ),
    fn(
        'vplan_list_cards',
        'List vPlan cards — the actual planned work items with their start/end date and time, stage, status and assigned resources. This is the main tool for "what is planned this week", "what is on this board" and "what is this person working on". Filter on start_date / end_date / stage_id / status_id / collection_id.',
        listParams('card', {
            collectionId: { type: 'string', description: 'Optional: only the cards of this collection. Note: an unknown collection id returns an empty list, not an error.' },
            enrichCustomFields: { type: 'boolean', description: 'Resolve custom-field values to their labels (default false)' },
        }),
    ),
    fn(
        'vplan_get_card',
        'Get one vPlan card in full: dates, stage, status, assigned resources, activities, labels, time tracking, and optionally its checklists and its relations to other cards (blocks / depends / related / cloned).',
        {
            type: 'object',
            properties: {
                collectionId: { type: 'string', description: 'Collection id the card belongs to' },
                cardId: { type: 'string', description: 'Card id from vplan_list_cards' },
                with: {
                    type: 'array',
                    description: 'Related objects to include on the card itself.',
                    items: { type: 'string', enum: WITH_OPTIONS.card },
                },
                includeChecklists: { type: 'boolean', description: 'Also fetch the checklists of this card (default true)' },
                includeRelations: { type: 'boolean', description: 'Also fetch the relations to other cards (default false)' },
            },
            required: ['collectionId', 'cardId'],
        },
    ),
    fn(
        'vplan_list_orders',
        'List vPlan orders — the sales, production, purchase, quotation or project orders pushed into vPlan from the source system, with their dates, status, quantity and links to relation/item/project/warehouse.',
        listParams('order', {
            orderId: { type: 'string', description: 'Optional: fetch one order by id instead of the list' },
        }),
    ),
    fn(
        'vplan_get_order',
        'Get one vPlan order together with its order rows (line items with quantities, units, delivered/backorder amounts and the activity each row maps to).',
        {
            type: 'object',
            properties: {
                orderId: { type: 'string', description: 'Order id from vplan_list_orders' },
                limit: { type: 'integer', description: `Maximum number of order rows (1-${MAX_LIMIT}, default ${MAX_LIMIT})` },
                offset: { type: 'integer', description: 'Pagination offset for the order rows (default 0)' },
            },
            required: ['orderId'],
        },
    ),
    fn(
        'vplan_list_time_tracking',
        'List individual vPlan time-tracking entries: start, end, duration in minutes, approval status, note, and the card / activity / user each entry belongs to. Filter on start, user_id, card_id, activity_id or status. For totals rather than entries, use vplan_time_tracking_summary.',
        listParams(null, {}),
    ),
    fn(
        'vplan_time_tracking_summary',
        'Get aggregated vPlan time tracking over a period, grouped by days, weeks, activities, collections, boards, statuses or users. Use this for "how many hours did we spend on X last month" instead of listing every entry.',
        {
            type: 'object',
            properties: {
                groupBy: { type: 'string', description: `How to aggregate. One of: ${TIME_TRACKING_GROUP_BY.join(', ')}` },
                start: { type: 'string', description: 'Start of the period, YYYY-MM-DD' },
                end: { type: 'string', description: 'End of the period, YYYY-MM-DD' },
            },
            required: [],
        },
    ),
    fn(
        'vplan_get_capacity',
        'Get planned versus available capacity for a vPlan board over a date range, broken down per stage, per resource, per group, or per resource type within each stage. Times are in minutes. Use this to answer "are we overbooked" and "where is the bottleneck".',
        {
            type: 'object',
            properties: {
                boardId: { type: 'string', description: 'Board id from vplan_list_boards' },
                scope: { type: 'string', description: 'Breakdown to return. One of: stage, resource, group, resource_type (default: stage)' },
                dateRangeStart: { type: 'string', description: 'Start of the range, YYYY-MM-DD' },
                dateRangeEnd: { type: 'string', description: 'End of the range, YYYY-MM-DD' },
                timeFrame: { type: 'string', description: `Bucket size. One of: ${TIME_FRAMES.join(', ')} (default: day)` },
                stageId: { type: 'string', description: 'Optional, scope "stage" only: limit to one stage' },
            },
            required: ['boardId', 'dateRangeStart', 'dateRangeEnd'],
        },
    ),
    fn(
        'vplan_list_master_data',
        'List one of the vPlan master-data sets: projects, items (products), relations (customers/vendors), warehouses, users, groups or spaces. Use this to resolve the IDs referenced by orders, cards and collections into readable names.',
        listParams(null, {
            type: { type: 'string', description: `Which master-data set to list. One of: ${Object.keys(MASTER_DATA_TYPES).join(', ')}` },
            id: { type: 'string', description: 'Optional: fetch one record by id instead of the list' },
            archived: { type: 'boolean', description: 'Include archived records — only applies to type "user" (default false)' },
        }, ['type']),
    ),
];

const VPLAN_TOOL_NAMES = new Set(VPLAN_TOOLS.map(t => t.function.name));

// ─── Pure helpers (exported for tests) ─────────────────────────

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
 * Map structured filters to vPlan's `field:operator:'value'` DSL, joined with
 * `,and,`. Values are always single-quoted so commas and colons survive; vPlan
 * documents no escaping inside quotes, so a value containing a quote is
 * rejected outright rather than silently mangled.
 */
function buildFilterParams(filters) {
    if (!Array.isArray(filters) || filters.length === 0) return null;
    const parts = [];
    for (const f of filters) {
        const field = String((f && f.field) || '');
        if (!FIELD_RE.test(field)) {
            throw new Error(`Invalid filter field: "${field}"`);
        }
        const operator = String((f && f.operator) || 'eq').trim().toLowerCase();
        if (!FILTER_OPERATORS.has(operator)) {
            throw new Error(`Unknown filter operator "${operator}". Use: ${[...FILTER_OPERATORS].join(', ')}`);
        }
        const value = String((f && f.value) !== undefined && f.value !== null ? f.value : '');
        if (value.includes("'")) {
            throw new Error("Filter values may not contain a single quote (vPlan cannot escape it inside a quoted value).");
        }
        parts.push(`${field}:${operator}:'${value}'`);
    }
    return parts.join(',and,');
}

function buildSortParam(sort) {
    if (!Array.isArray(sort) || sort.length === 0) return null;
    const parts = [];
    for (const s of sort) {
        const field = String((s && s.field) || '');
        if (!FIELD_RE.test(field)) {
            throw new Error(`Invalid sort field: "${field}"`);
        }
        const direction = String((s && s.direction) || 'asc').trim().toLowerCase();
        if (direction !== 'asc' && direction !== 'desc') {
            throw new Error(`Invalid sort direction "${s.direction}". Use "asc" or "desc".`);
        }
        parts.push(`${field}:${direction}`);
    }
    return parts.join(',');
}

/**
 * Filter the requested eager-loaded relations down to the ones vPlan documents
 * for this endpoint. Unknown entries are dropped, not forwarded — a hallucinated
 * relation name would otherwise fail the whole request.
 */
function buildWithParam(requested, withKey) {
    const allowed = WITH_OPTIONS[withKey];
    if (!allowed || !requested) return null;
    const list = Array.isArray(requested) ? requested : String(requested).split(',');
    const kept = list.map(v => String(v || '').trim()).filter(v => allowed.includes(v));
    return kept.length ? [...new Set(kept)].join(',') : null;
}

function requireUuid(value, label) {
    const id = String(value || '').trim();
    if (!UUID_RE.test(id)) {
        throw new Error(`Invalid ${label} — expected a vPlan id (UUID).`);
    }
    return id;
}

function requireDate(value, label) {
    const d = String(value || '').trim();
    if (!DATE_RE.test(d)) {
        throw new Error(`Invalid ${label} — expected a date in YYYY-MM-DD format.`);
    }
    return d;
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
        } catch { /* not JSON after all */ }
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

// ─── API client ────────────────────────────────────────────────

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

async function vplanRequest(creds, path, query = null, retried = false) {
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
        } catch { /* body unreadable — keep the mapped reason */ }
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

/** Shared pagination/filter/sort/with query for the list tools. */
function buildListQuery(args, withKey, defaultLimit = DEFAULT_LIMIT) {
    const query = {
        limit: String(clampLimit(args.limit, defaultLimit)),
        offset: String(clampOffset(args.offset)),
    };
    const filter = buildFilterParams(args.filters);
    if (filter) query.filter = filter;
    const sort = buildSortParam(args.sort);
    if (sort) query.sort = sort;
    const withParam = buildWithParam(args.with, withKey);
    if (withParam) query.with = withParam;
    return query;
}

// ─── Credentials ───────────────────────────────────────────────

async function getVplanCredentials(userId) {
    const apiKey = await configStore.getSecret(`vplan_api_key_user_${userId}`);
    const apiEnv = await configStore.getSecret(`vplan_api_env_user_${userId}`);
    if (!apiKey || !apiEnv) return null;
    return { apiKey: String(apiKey).trim(), apiEnv: String(apiEnv).trim() };
}

/**
 * Re-validate the stored credentials before they reach a request header. The
 * save path validates too, but a value written by an older build (or restored
 * from a backup) must never be able to inject a header.
 */
function assertValidCredentials(creds) {
    if (!API_KEY_RE.test(creds.apiKey)) {
        throw new Error('The stored vPlan API key has an invalid format. Re-enter it in Settings → Integrations.');
    }
    if (!API_ENV_RE.test(creds.apiEnv)) {
        throw new Error('The stored vPlan environment has an invalid format. Re-enter it in Settings → Integrations.');
    }
}

// ─── Tool execution ────────────────────────────────────────────

async function runVplanTool(toolName, args, creds) {
    switch (toolName) {
        case 'vplan_whoami': {
            const me = await vplanRequest(creds, '/me');
            return {
                type: me?.type || null,
                environment: me?.environment || null,
                organizations: me?.organizations || null,
                user: me?.user || null,
                features: me?.features || null,
                permissions: me?.permissions || null,
            };
        }

        case 'vplan_list_boards': {
            if (args.boardId) {
                const id = requireUuid(args.boardId, 'boardId');
                return { board: await vplanRequest(creds, `/board/${id}`) };
            }
            return vplanList(creds, '/board', buildListQuery(args, 'board'));
        }

        case 'vplan_list_resources': {
            if (args.resourceId) {
                const id = requireUuid(args.resourceId, 'resourceId');
                return { resource: await vplanRequest(creds, `/resource/${id}`) };
            }
            const query = buildListQuery(args, 'resource');
            if (args.archived === true) query.archived = 'true';
            return vplanList(creds, '/resource', query);
        }

        case 'vplan_get_resource_availability': {
            const id = requireUuid(args.resourceId, 'resourceId');
            const start = requireDate(args.start, 'start');
            const end = requireDate(args.end, 'end');
            const schedule = await vplanList(creds, `/resource/${id}/schedule`, {
                limit: String(clampLimit(args.limit, MAX_LIMIT)),
                offset: String(clampOffset(args.offset)),
                filter: `date:gte:'${start}',and,date:lte:'${end}'`,
                sort: 'date:asc',
            });
            const result = { resourceId: id, start, end, schedule };
            if (args.includeAbsences !== false) {
                // An absence counts when it overlaps the range at either end.
                result.absences = await vplanList(creds, `/resource/${id}/schedule_deviation`, {
                    limit: String(MAX_LIMIT),
                    offset: '0',
                    filter: `end_date:gte:'${start}',and,start_date:lte:'${end}'`,
                    sort: 'start_date:asc',
                });
            }
            return result;
        }

        case 'vplan_list_activities': {
            if (args.activityId) {
                const id = requireUuid(args.activityId, 'activityId');
                return { activity: await vplanRequest(creds, `/activity/${id}`) };
            }
            return vplanList(creds, '/activity', buildListQuery(args, 'activity'));
        }

        case 'vplan_list_collections': {
            const query = buildListQuery(args, 'collection');
            if (args.boardId) {
                const boardId = requireUuid(args.boardId, 'boardId');
                const scoped = `board_id:eq:'${boardId}'`;
                query.filter = query.filter ? `${query.filter},and,${scoped}` : scoped;
            }
            return vplanList(creds, '/collection', query);
        }

        case 'vplan_get_collection': {
            const id = requireUuid(args.collectionId, 'collectionId');
            const result = { collection: await vplanRequest(creds, `/collection/${id}`) };
            const include = Array.isArray(args.include) ? args.include : [];
            // Fetched as separate documented sub-resources rather than via `with`,
            // which the single-collection endpoint does not document.
            const pageQuery = { limit: String(MAX_LIMIT), offset: '0' };
            if (include.includes('cards')) {
                result.cards = await vplanList(creds, `/collection/${id}/card`, pageQuery);
            }
            if (include.includes('attachments')) {
                result.attachments = await vplanList(creds, `/collection/${id}/attachment`, pageQuery);
            }
            if (include.includes('comments')) {
                result.comments = await vplanList(creds, `/collection/${id}/comment`, pageQuery);
            }
            if (include.includes('checklists')) {
                result.checklists = await vplanList(creds, `/collection/${id}/checklist`, pageQuery);
            }
            return result;
        }

        case 'vplan_list_cards': {
            const query = buildListQuery(args, 'card');
            if (args.enrichCustomFields === true) query.enrich_custom_fields = 'true';
            if (args.collectionId) {
                const id = requireUuid(args.collectionId, 'collectionId');
                const result = await vplanList(creds, `/collection/${id}/card`, query);
                if (result.count === 0) {
                    result.message = 'No cards returned. Note that vPlan answers with an empty list — not an error — when the collection id does not exist.';
                }
                return result;
            }
            return vplanList(creds, '/card', query);
        }

        case 'vplan_get_card': {
            const collectionId = requireUuid(args.collectionId, 'collectionId');
            const cardId = requireUuid(args.cardId, 'cardId');
            const query = {};
            const withParam = buildWithParam(args.with, 'card');
            if (withParam) query.with = withParam;
            const result = { card: await vplanRequest(creds, `/collection/${collectionId}/card/${cardId}`, query) };
            if (args.includeChecklists !== false) {
                result.checklists = await vplanList(creds, `/collection/${collectionId}/card/${cardId}/checklist`, { limit: String(MAX_LIMIT), offset: '0' });
            }
            if (args.includeRelations === true) {
                result.relations = await vplanList(creds, '/card_relation', {
                    limit: String(MAX_LIMIT),
                    offset: '0',
                    filter: `card_id:eq:'${cardId}'`,
                });
            }
            return result;
        }

        case 'vplan_list_orders': {
            if (args.orderId) {
                const id = requireUuid(args.orderId, 'orderId');
                return { order: await vplanRequest(creds, `/order/${id}`) };
            }
            return vplanList(creds, '/order', buildListQuery(args, 'order'));
        }

        case 'vplan_get_order': {
            const id = requireUuid(args.orderId, 'orderId');
            const order = await vplanRequest(creds, `/order/${id}`);
            const rows = await vplanList(creds, `/order/${id}/row`, {
                limit: String(clampLimit(args.limit, MAX_LIMIT)),
                offset: String(clampOffset(args.offset)),
            });
            return { order, rows };
        }

        case 'vplan_list_time_tracking':
            return vplanList(creds, '/time_tracking', buildListQuery(args, null));

        case 'vplan_time_tracking_summary': {
            const query = {};
            if (args.groupBy) {
                const groupBy = String(args.groupBy).trim().toLowerCase();
                if (!TIME_TRACKING_GROUP_BY.includes(groupBy)) {
                    throw new Error(`Invalid groupBy "${args.groupBy}". Use: ${TIME_TRACKING_GROUP_BY.join(', ')}`);
                }
                query.group_by = groupBy;
            }
            if (args.start) query.start = requireDate(args.start, 'start');
            if (args.end) query.end = requireDate(args.end, 'end');
            return { summary: await vplanRequest(creds, '/time_tracking/export', query) };
        }

        case 'vplan_get_capacity': {
            const boardId = requireUuid(args.boardId, 'boardId');
            const scope = String(args.scope || 'stage').trim().toLowerCase();
            const suffix = CAPACITY_SCOPES[scope];
            if (!suffix) {
                throw new Error(`Invalid scope "${args.scope}". Use: ${Object.keys(CAPACITY_SCOPES).join(', ')}`);
            }
            const query = {
                date_range_start: requireDate(args.dateRangeStart, 'dateRangeStart'),
                date_range_end: requireDate(args.dateRangeEnd, 'dateRangeEnd'),
            };
            if (args.timeFrame) {
                const timeFrame = String(args.timeFrame).trim().toLowerCase();
                if (!TIME_FRAMES.includes(timeFrame)) {
                    throw new Error(`Invalid timeFrame "${args.timeFrame}". Use: ${TIME_FRAMES.join(', ')}`);
                }
                query.time_frame = timeFrame;
            }
            if (args.stageId && scope === 'stage') {
                query.stage_id = requireUuid(args.stageId, 'stageId');
            }
            const payload = await vplanRequest(creds, `/board/${boardId}/capacity/${suffix}`, query);
            const all = (payload && Array.isArray(payload.data)) ? payload.data : [];
            const { rows, truncated } = truncateRows(all);
            const result = { boardId, scope, timeFrame: query.time_frame || 'day', unit: 'minutes', data: rows };
            if (truncated) {
                result.truncated = true;
                result.message = `Response too large — showing ${rows.length} of ${all.length} buckets. Narrow the date range or use a larger timeFrame.`;
            }
            return result;
        }

        case 'vplan_list_master_data': {
            const type = String(args.type || '').trim().toLowerCase();
            const spec = MASTER_DATA_TYPES[type];
            if (!spec) {
                throw new Error(`Invalid type "${args.type}". Use: ${Object.keys(MASTER_DATA_TYPES).join(', ')}`);
            }
            if (args.id) {
                const id = requireUuid(args.id, 'id');
                return { type, record: await vplanRequest(creds, `${spec.path}/${id}`) };
            }
            const query = buildListQuery(args, spec.withKey || null);
            if (spec.supportsArchived && args.archived === true) query.archived = 'true';
            const result = await vplanList(creds, spec.path, query);
            result.type = type;
            return result;
        }

        default:
            throw new Error(`Unknown vPlan tool: ${toolName}`);
    }
}

async function executeVplanTool(toolName, args, userId) {
    if (!userId) return { error: 'User context required for vPlan.' };
    if (!isVplanTool(toolName)) return { error: `Unknown vPlan tool: ${toolName}` };

    const creds = await getVplanCredentials(userId);
    if (!creds) {
        return { error: 'vPlan not configured. Add your API key and environment in Settings → Integrations.' };
    }

    try {
        assertValidCredentials(creds);
        log.info(`[vPlan] ${toolName}`);
        return await runVplanTool(toolName, args || {}, creds);
    } catch (err) {
        log.warn(`[vPlan] ${toolName} failed: ${err.message}`);
        return { error: `vPlan: ${err.message}` };
    }
}

function isVplanTool(toolName) {
    return VPLAN_TOOL_NAMES.has(toolName);
}

module.exports = {
    VPLAN_TOOLS,
    executeVplanTool,
    isVplanTool,
    // Shape checks reused by the settings save path.
    API_KEY_RE,
    API_ENV_RE,
    // Pure helpers exported for unit tests.
    buildFilterParams,
    buildSortParam,
    buildWithParam,
    buildUrl,
    buildListQuery,
    clampLimit,
    clampOffset,
    truncateRows,
    stripNoise,
    extractVplanErrorMessage,
    retryDelayMs,
    WITH_OPTIONS,
    MAX_LIMIT,
};

// @typecheck
const { DEFAULT_LIMIT, WITH_OPTIONS } = require('./vplanToolDefs');
const { clampLimit, clampOffset } = require('./vplanClient');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// vPlan filter operators (docs.api.vplan.com/filtering).
const FILTER_OPERATORS = new Set([
    'eq', 'not', 'gt', 'gte', 'lt', 'lte', 'has', 'contains', 'starts_with', 'ends_with',
]);

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

module.exports = { buildFilterParams, buildSortParam, buildWithParam, requireUuid, requireDate, buildListQuery };

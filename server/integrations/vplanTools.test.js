/**
 * Unit tests for the vPlan tool module.
 *
 * Run: node --test integrations/vplanTools.test.js
 *
 * No network/DB needed — `configStore` is stubbed (same trick as
 * afasTools.test.js) and `global.fetch` is scripted per case.
 */

const assert = require('assert');

// Stub configStore before requiring the module under test.
const SECRETS = {};
const configStorePath = require.resolve('../stores/configStore');
require.cache[configStorePath] = {
    id: configStorePath,
    filename: configStorePath,
    loaded: true,
    exports: {
        getSecret: async (key) => SECRETS[key] ?? null,
    },
};

const {
    VPLAN_TOOLS,
    executeVplanTool,
    isVplanTool,
    API_KEY_RE,
    API_ENV_RE,
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
} = require('./vplanTools');

const KEY = 'vpk_9f3a1c7e5b2d8046aa31ce77b0d4e912';
const ENV = 'env_7c1f4a9d';
const UUID = '26f48a32-2e38-432f-93be-ba1b82b48962';
const UUID2 = '69b3c2ff-4c10-4513-a78a-e93277a1a8a4';

function setCreds(userId, { key = KEY, env = ENV } = {}) {
    SECRETS[`vplan_api_key_user_${userId}`] = key;
    SECRETS[`vplan_api_env_user_${userId}`] = env;
}

function clearCreds(userId) {
    delete SECRETS[`vplan_api_key_user_${userId}`];
    delete SECRETS[`vplan_api_env_user_${userId}`];
}

// ── fetch stub ─────────────────────────────────────────────────────────
let fetchCalls = [];
function scriptFetch(responses) {
    // responses: one { ok, status, json | text | headers } per expected request, in order.
    fetchCalls = [];
    global.fetch = async (url, opts) => {
        fetchCalls.push({ url, opts });
        const r = responses[fetchCalls.length - 1];
        if (r === undefined) throw new Error(`Unexpected upstream request #${fetchCalls.length}: ${url}`);
        const headers = new Map(Object.entries(r.headers || {}));
        return {
            ok: r.ok !== undefined ? r.ok : (r.status || 200) < 400,
            status: r.status || 200,
            headers: { get: (name) => headers.get(name) ?? null },
            json: async () => r.json,
            text: async () => r.text ?? JSON.stringify(r.json ?? {}),
        };
    };
}

function listBody(data, count) {
    return { count: count ?? data.length, limit: 25, offset: 0, data };
}

function queryOf(call) {
    return Object.fromEntries(new URL(call.url).searchParams);
}

(async () => {
    // ── credential shapes ─────────────────────────────────────────────
    assert.ok(API_KEY_RE.test(KEY));
    assert.ok(API_ENV_RE.test(ENV));
    for (const bad of ['', 'short', `has space ${KEY}`, `crlf\r\ninjected${KEY}`, `${KEY}\n`, `tab\t${KEY}`]) {
        assert.ok(!API_KEY_RE.test(bad), `api key rejected: ${JSON.stringify(bad)}`);
    }
    for (const bad of ['', 'a', 'has space', 'env\r\nX-Evil: 1', 'env\n']) {
        assert.ok(!API_ENV_RE.test(bad), `api env rejected: ${JSON.stringify(bad)}`);
    }

    // ── buildFilterParams ─────────────────────────────────────────────
    assert.strictEqual(buildFilterParams(null), null);
    assert.strictEqual(buildFilterParams([]), null);
    assert.strictEqual(
        buildFilterParams([{ field: 'start_date', operator: 'gte', value: '2026-08-01' }]),
        "start_date:gte:'2026-08-01'",
    );
    assert.strictEqual(
        buildFilterParams([
            { field: 'start_date', operator: 'gte', value: '2026-08-01' },
            { field: 'name', operator: 'contains', value: 'Order, 10199' },
        ]),
        "start_date:gte:'2026-08-01',and,name:contains:'Order, 10199'",
        'values keep commas and colons because they are always quoted',
    );
    assert.strictEqual(
        buildFilterParams([{ field: 'status', value: 'planned' }]),
        "status:eq:'planned'",
        'operator defaults to eq',
    );
    assert.throws(() => buildFilterParams([{ field: 'name', operator: 'regex', value: 'x' }]), /Unknown filter operator/);
    for (const bad of ['', 'name;drop', 'na me', "name'", '1name', `x${'y'.repeat(80)}`]) {
        assert.throws(() => buildFilterParams([{ field: bad, value: 'x' }]), /Invalid filter field/, `field rejected: ${JSON.stringify(bad)}`);
    }
    assert.throws(
        () => buildFilterParams([{ field: 'name', value: "it's here" }]),
        /single quote/,
        'a value containing a quote is rejected — vPlan documents no escaping',
    );

    // ── buildSortParam ────────────────────────────────────────────────
    assert.strictEqual(buildSortParam(null), null);
    assert.strictEqual(buildSortParam([{ field: 'updated_at', direction: 'desc' }, { field: 'name' }]), 'updated_at:desc,name:asc');
    assert.throws(() => buildSortParam([{ field: 'name', direction: 'sideways' }]), /sort direction/);
    assert.throws(() => buildSortParam([{ field: 'na me' }]), /Invalid sort field/);

    // ── buildWithParam ────────────────────────────────────────────────
    assert.strictEqual(buildWithParam(['stages'], 'board'), 'stages');
    assert.strictEqual(buildWithParam(['stages', 'stages'], 'board'), 'stages', 'de-duplicated');
    assert.strictEqual(buildWithParam(['stages', 'nonsense'], 'board'), 'stages', 'unknown relations are dropped, not forwarded');
    assert.strictEqual(buildWithParam(['nonsense'], 'board'), null);
    assert.strictEqual(buildWithParam(['resources'], null), null, 'no allow-list for this endpoint means no with param');
    assert.strictEqual(buildWithParam('collection,labels', 'card'), 'collection,labels', 'accepts a comma string too');
    // vPlan's docs list `statuses` for the card endpoint but the live API answers
    // "Relation not found: statuses" — it must never be forwarded.
    assert.ok(!WITH_OPTIONS.card.includes('statuses'), 'statuses is not an allowed card relation');
    assert.strictEqual(buildWithParam(['statuses'], 'card'), null);
    assert.strictEqual(buildWithParam(['stage', 'statuses'], 'card'), 'stage');
    for (const [key, allowed] of Object.entries(WITH_OPTIONS)) {
        assert.ok(allowed.length > 0, `${key} has with-options`);
    }

    // ── clamping ──────────────────────────────────────────────────────
    assert.strictEqual(clampLimit(undefined), 25);
    assert.strictEqual(clampLimit(5000), MAX_LIMIT, 'clamped well below vPlan\'s own 1000 max');
    assert.strictEqual(clampLimit(0), 1);
    assert.strictEqual(clampLimit('40'), 40);
    assert.strictEqual(clampOffset(-5), 0);
    assert.strictEqual(clampOffset('30'), 30);

    // ── buildUrl / buildListQuery ─────────────────────────────────────
    assert.strictEqual(buildUrl('/board', null), 'https://api.vplan.com/v1/board');
    assert.strictEqual(buildUrl('/board', { limit: '25', offset: '' }), 'https://api.vplan.com/v1/board?limit=25', 'empty values are dropped');
    const q = buildListQuery({ limit: 10, offset: 20, filters: [{ field: 'name', value: 'x' }], sort: [{ field: 'name' }], with: ['stages'] }, 'board');
    assert.deepStrictEqual(q, { limit: '10', offset: '20', filter: "name:eq:'x'", sort: 'name:asc', with: 'stages' });

    // ── truncateRows ──────────────────────────────────────────────────
    const small = [{ a: 1 }, { a: 2 }];
    assert.deepStrictEqual(truncateRows(small, 1000), { rows: small, truncated: false });
    const big = Array.from({ length: 64 }, (_, i) => ({ i, pad: 'x'.repeat(200) }));
    const trimmed = truncateRows(big, 2000);
    assert.ok(trimmed.truncated && trimmed.rows.length > 0 && trimmed.rows.length < big.length);
    assert.deepStrictEqual(truncateRows([{ pad: 'x'.repeat(500) }], 100), { rows: [], truncated: true }, 'a single oversized row is dropped');

    // ── stripNoise ────────────────────────────────────────────────────
    assert.deepStrictEqual(
        stripNoise({ id: '1', cover_image_checksum: 'ab', cover_image_signature: 'cd', nested: [{ thumbnail_checksum: 'e', name: 'n' }] }),
        { id: '1', nested: [{ name: 'n' }] },
    );

    // ── extractVplanErrorMessage ──────────────────────────────────────
    assert.strictEqual(
        extractVplanErrorMessage(JSON.stringify({ reference: UUID, errors: [{ code: 10005, message: 'Memory exhausted', description: 'Reduce the page size' }] })),
        'Reduce the page size',
    );
    assert.strictEqual(extractVplanErrorMessage(JSON.stringify({ errors: [{ message: 'Nope' }] })), 'Nope');
    assert.strictEqual(extractVplanErrorMessage('<html>maintenance</html>'), null);
    assert.strictEqual(extractVplanErrorMessage(''), null);

    // ── retryDelayMs ──────────────────────────────────────────────────
    const hdr = (v) => ({ get: () => v });
    assert.strictEqual(retryDelayMs(hdr('2')), 2000);
    assert.strictEqual(retryDelayMs(hdr('9999')), 5000, 'capped so a hostile value cannot stall the agent loop');
    assert.strictEqual(retryDelayMs(hdr(null)), 1000);

    // ── tool registry hygiene ─────────────────────────────────────────
    assert.strictEqual(VPLAN_TOOLS.length, 15);
    const names = VPLAN_TOOLS.map(t => t.function.name);
    assert.strictEqual(new Set(names).size, names.length, 'no duplicate tool names');
    for (const name of names) {
        assert.ok(name.startsWith('vplan_'), `tool name is prefixed: ${name}`);
        assert.ok(isVplanTool(name), `isVplanTool recognises ${name}`);
        assert.ok(
            !/(create|update|delete|remove|add|set|write|post|put|patch|move|split|plan_on|archive)/.test(name),
            `read-only tool name contains no mutation verb: ${name}`,
        );
    }
    assert.ok(!isVplanTool('vplan_create_card'));
    assert.ok(!isVplanTool('afas_query'));
    for (const t of VPLAN_TOOLS) {
        assert.strictEqual(t.type, 'function');
        assert.ok(t.function.description.length > 40, `${t.function.name} has a usable description`);
        assert.strictEqual(t.function.parameters.type, 'object');
        for (const req of t.function.parameters.required || []) {
            assert.ok(t.function.parameters.properties[req], `${t.function.name}: required "${req}" is declared`);
        }
    }

    // ── missing / invalid credentials ─────────────────────────────────
    clearCreds('u0');
    assert.match((await executeVplanTool('vplan_whoami', {}, 'u0')).error, /not configured/);
    assert.match((await executeVplanTool('vplan_whoami', {}, null)).error, /User context required/);

    scriptFetch([]);
    setCreds('u-bad', { key: 'nope' });
    assert.match((await executeVplanTool('vplan_whoami', {}, 'u-bad')).error, /API key has an invalid format/);
    setCreds('u-bad2', { env: 'bad env' });
    assert.match((await executeVplanTool('vplan_whoami', {}, 'u-bad2')).error, /environment has an invalid format/);
    assert.strictEqual(fetchCalls.length, 0, 'a malformed stored credential never reaches the network');

    setCreds('u1');

    // ── headers, method and redirect handling ─────────────────────────
    scriptFetch([{ json: { type: 'api_key', environment: { customer: 'Acme BV' }, permissions: ['read'] } }]);
    const who = await executeVplanTool('vplan_whoami', {}, 'u1');
    assert.strictEqual(who.environment.customer, 'Acme BV');
    assert.strictEqual(fetchCalls[0].url, 'https://api.vplan.com/v1/me');
    assert.strictEqual(fetchCalls[0].opts.method, 'GET');
    assert.strictEqual(fetchCalls[0].opts.headers['X-Api-Key'], KEY);
    assert.strictEqual(fetchCalls[0].opts.headers['X-Api-Env'], ENV);
    assert.strictEqual(fetchCalls[0].opts.redirect, 'manual', 'the 303 maintenance redirect must not be followed');

    // ── every tool issues GETs only ───────────────────────────────────
    scriptFetch([
        { json: listBody([{ id: UUID, name: 'Board A' }]) },
        { json: listBody([{ id: UUID, name: 'Painting' }]) },
        { json: listBody([{ id: UUID, name: 'Alice', type: 'employee' }]) },
        { json: listBody([{ id: UUID, name: 'Job 1' }]) },
        { json: listBody([{ id: UUID, name: 'Card 1' }]) },
        { json: listBody([{ id: UUID, code: 'SO-1' }]) },
        { json: listBody([{ id: UUID, duration: 60 }]) },
        { json: listBody([{ id: UUID, name: 'Project X' }]) },
    ]);
    await executeVplanTool('vplan_list_boards', {}, 'u1');
    await executeVplanTool('vplan_list_activities', {}, 'u1');
    await executeVplanTool('vplan_list_resources', {}, 'u1');
    await executeVplanTool('vplan_list_collections', {}, 'u1');
    await executeVplanTool('vplan_list_cards', {}, 'u1');
    await executeVplanTool('vplan_list_orders', {}, 'u1');
    await executeVplanTool('vplan_list_time_tracking', {}, 'u1');
    await executeVplanTool('vplan_list_master_data', { type: 'project' }, 'u1');
    assert.strictEqual(fetchCalls.length, 8);
    for (const call of fetchCalls) {
        assert.strictEqual(call.opts.method, 'GET', `read-only: ${call.url} is a GET`);
        assert.strictEqual(call.opts.body, undefined, 'no request body is ever sent');
        assert.ok(call.url.startsWith('https://api.vplan.com/v1/'), `pinned host: ${call.url}`);
    }
    assert.deepStrictEqual(
        fetchCalls.map(c => new URL(c.url).pathname),
        ['/v1/board', '/v1/activity', '/v1/resource', '/v1/collection', '/v1/card', '/v1/order', '/v1/time_tracking', '/v1/project'],
    );

    // ── pagination envelope ───────────────────────────────────────────
    scriptFetch([{ json: listBody([{ id: UUID, name: 'Card 1' }], 140) }]);
    const cards = await executeVplanTool('vplan_list_cards', { limit: 1, offset: 0 }, 'u1');
    assert.strictEqual(cards.total, 140);
    assert.strictEqual(cards.hasMore, true);
    assert.strictEqual(cards.limit, 1);
    assert.strictEqual(queryOf(fetchCalls[0]).limit, '1');

    scriptFetch([{ json: listBody([], 0) }]);
    const emptyCards = await executeVplanTool('vplan_list_cards', { collectionId: UUID2 }, 'u1');
    assert.match(emptyCards.message, /empty list/, 'warns that vPlan returns an empty list for an unknown collection id');
    assert.strictEqual(new URL(fetchCalls[0].url).pathname, `/v1/collection/${UUID2}/card`);

    // ── filters, sort and with reach the query string ─────────────────
    scriptFetch([{ json: listBody([]) }]);
    await executeVplanTool('vplan_list_cards', {
        filters: [{ field: 'start_date', operator: 'gte', value: '2026-08-01' }],
        sort: [{ field: 'start_date' }],
        with: ['stage', 'resources', 'made_up'],
        enrichCustomFields: true,
    }, 'u1');
    const cardQuery = queryOf(fetchCalls[0]);
    assert.strictEqual(cardQuery.filter, "start_date:gte:'2026-08-01'");
    assert.strictEqual(cardQuery.sort, 'start_date:asc');
    assert.strictEqual(cardQuery.with, 'stage,resources', 'the invented relation was dropped');
    assert.strictEqual(cardQuery.enrich_custom_fields, 'true');

    // boardId is folded into the filter rather than sent as an unsupported param
    scriptFetch([{ json: listBody([]) }]);
    await executeVplanTool('vplan_list_collections', { boardId: UUID, filters: [{ field: 'status', value: 'planned' }] }, 'u1');
    assert.strictEqual(queryOf(fetchCalls[0]).filter, `status:eq:'planned',and,board_id:eq:'${UUID}'`);

    // ── id validation happens before any request ──────────────────────
    scriptFetch([]);
    for (const [tool, args] of [
        ['vplan_list_boards', { boardId: 'not-a-uuid' }],
        ['vplan_get_collection', { collectionId: '../../admin' }],
        ['vplan_get_card', { collectionId: UUID, cardId: 'x' }],
        ['vplan_get_order', { orderId: '1' }],
        ['vplan_get_capacity', { boardId: 'x', dateRangeStart: '2026-01-01', dateRangeEnd: '2026-02-01' }],
        ['vplan_get_resource_availability', { resourceId: 'x', start: '2026-01-01', end: '2026-01-31' }],
    ]) {
        const r = await executeVplanTool(tool, args, 'u1');
        assert.match(r.error, /Invalid/, `${tool} rejects a bad id: ${r.error}`);
    }
    assert.strictEqual(fetchCalls.length, 0, 'no request is made for an invalid id');

    // ── date validation ───────────────────────────────────────────────
    scriptFetch([]);
    assert.match(
        (await executeVplanTool('vplan_get_capacity', { boardId: UUID, dateRangeStart: 'last monday', dateRangeEnd: '2026-02-01' }, 'u1')).error,
        /YYYY-MM-DD/,
    );
    assert.match(
        (await executeVplanTool('vplan_get_capacity', { boardId: UUID, dateRangeStart: '2026-01-01', dateRangeEnd: '2026-02-01', scope: 'nonsense' }, 'u1')).error,
        /Invalid scope/,
    );
    assert.match(
        (await executeVplanTool('vplan_get_capacity', { boardId: UUID, dateRangeStart: '2026-01-01', dateRangeEnd: '2026-02-01', timeFrame: 'fortnight' }, 'u1')).error,
        /Invalid timeFrame/,
    );
    assert.match(
        (await executeVplanTool('vplan_time_tracking_summary', { groupBy: 'aliens' }, 'u1')).error,
        /Invalid groupBy/,
    );
    assert.match((await executeVplanTool('vplan_list_master_data', { type: 'aliens' }, 'u1')).error, /Invalid type/);
    assert.strictEqual(fetchCalls.length, 0);

    // ── capacity ──────────────────────────────────────────────────────
    scriptFetch([{ json: { data: [{ date: '2026-08-01', stage: [{ id: UUID, time_available: 1920, time_planned: 480 }] }] } }]);
    const cap = await executeVplanTool('vplan_get_capacity', {
        boardId: UUID, scope: 'resource_type', dateRangeStart: '2026-08-01', dateRangeEnd: '2026-09-01', timeFrame: 'week',
    }, 'u1');
    assert.strictEqual(new URL(fetchCalls[0].url).pathname, `/v1/board/${UUID}/capacity/resource_type/stage`);
    assert.deepStrictEqual(queryOf(fetchCalls[0]), { date_range_start: '2026-08-01', date_range_end: '2026-09-01', time_frame: 'week' });
    assert.strictEqual(cap.unit, 'minutes');
    assert.strictEqual(cap.data.length, 1);

    // ── resource availability: schedule + overlapping absences ────────
    scriptFetch([
        { json: listBody([{ date: '2026-08-03', hours_available: 8, hours_work: 6, hours_leave: 0, hours_absence: 0 }]) },
        { json: listBody([{ id: UUID, type: 'holiday', start_date: '2026-08-10', end_date: '2026-08-14' }]) },
    ]);
    const avail = await executeVplanTool('vplan_get_resource_availability', { resourceId: UUID, start: '2026-08-01', end: '2026-08-31' }, 'u1');
    assert.strictEqual(avail.schedule.count, 1);
    assert.strictEqual(avail.absences.count, 1);
    assert.strictEqual(new URL(fetchCalls[0].url).pathname, `/v1/resource/${UUID}/schedule`);
    assert.strictEqual(queryOf(fetchCalls[0]).filter, "date:gte:'2026-08-01',and,date:lte:'2026-08-31'");
    assert.strictEqual(new URL(fetchCalls[1].url).pathname, `/v1/resource/${UUID}/schedule_deviation`);
    assert.strictEqual(queryOf(fetchCalls[1]).filter, "end_date:gte:'2026-08-01',and,start_date:lte:'2026-08-31'");

    scriptFetch([{ json: listBody([]) }]);
    const availNoAbs = await executeVplanTool('vplan_get_resource_availability', { resourceId: UUID, start: '2026-08-01', end: '2026-08-31', includeAbsences: false }, 'u1');
    assert.strictEqual(availNoAbs.absences, undefined);
    assert.strictEqual(fetchCalls.length, 1);

    // ── collection detail fans out to documented sub-resources ────────
    scriptFetch([
        { json: { id: UUID2, name: 'Order 10199' } },
        { json: listBody([{ id: UUID, name: 'Card 1' }]) },
        { json: listBody([{ id: UUID, text: 'Hi' }]) },
    ]);
    const coll = await executeVplanTool('vplan_get_collection', { collectionId: UUID2, include: ['cards', 'comments'] }, 'u1');
    assert.strictEqual(coll.collection.name, 'Order 10199');
    assert.strictEqual(coll.cards.count, 1);
    assert.strictEqual(coll.comments.count, 1);
    assert.strictEqual(coll.attachments, undefined);
    assert.deepStrictEqual(
        fetchCalls.map(c => new URL(c.url).pathname),
        [`/v1/collection/${UUID2}`, `/v1/collection/${UUID2}/card`, `/v1/collection/${UUID2}/comment`],
    );

    // ── card detail ───────────────────────────────────────────────────
    scriptFetch([
        { json: { id: UUID, name: 'Card 1' } },
        { json: listBody([{ id: UUID, name: 'Checklist' }]) },
        { json: listBody([{ id: UUID, type: 'blocks' }]) },
    ]);
    const card = await executeVplanTool('vplan_get_card', { collectionId: UUID2, cardId: UUID, with: ['resources'], includeRelations: true }, 'u1');
    assert.strictEqual(card.card.name, 'Card 1');
    assert.strictEqual(card.checklists.count, 1);
    assert.strictEqual(card.relations.count, 1);
    assert.strictEqual(queryOf(fetchCalls[0]).with, 'resources');
    assert.strictEqual(queryOf(fetchCalls[2]).filter, `card_id:eq:'${UUID}'`);

    // ── order + rows ──────────────────────────────────────────────────
    scriptFetch([
        { json: { id: UUID, code: 'SO-1' } },
        { json: listBody([{ id: UUID2, description: 'Row 1' }]) },
    ]);
    const order = await executeVplanTool('vplan_get_order', { orderId: UUID }, 'u1');
    assert.strictEqual(order.order.code, 'SO-1');
    assert.strictEqual(order.rows.count, 1);
    assert.strictEqual(new URL(fetchCalls[1].url).pathname, `/v1/order/${UUID}/row`);

    // ── master data ───────────────────────────────────────────────────
    scriptFetch([{ json: listBody([{ id: UUID, email: 'a@b.nl' }]) }]);
    const users = await executeVplanTool('vplan_list_master_data', { type: 'user', archived: true, with: ['resource'] }, 'u1');
    assert.strictEqual(users.type, 'user');
    assert.strictEqual(queryOf(fetchCalls[0]).archived, 'true');
    assert.strictEqual(queryOf(fetchCalls[0]).with, 'resource');

    scriptFetch([{ json: listBody([{ id: UUID, name: 'Acme' }]) }]);
    await executeVplanTool('vplan_list_master_data', { type: 'relation', archived: true }, 'u1');
    assert.strictEqual(queryOf(fetchCalls[0]).archived, undefined, 'archived only applies to users');

    // ── status mapping, sanitised ─────────────────────────────────────
    const SECRET_FILTER = 'Zeer Geheim BV';
    for (const [status, pattern] of [
        [400, /rejected the request/],
        [401, /invalid or has been revoked/],
        [403, /not allowed to read/],
        [404, /not found/],
        [422, /could not process/],
    ]) {
        scriptFetch([{ status, json: { errors: [{ description: 'upstream detail' }] } }]);
        const r = await executeVplanTool('vplan_list_cards', { filters: [{ field: 'name', value: SECRET_FILTER }] }, 'u1');
        assert.match(r.error, pattern, `HTTP ${status} maps to a readable reason`);
        assert.match(r.error, /upstream detail/, `HTTP ${status} keeps the sanitised upstream message`);
        assert.ok(!r.error.includes('api.vplan.com'), `HTTP ${status}: the URL never leaks into the error`);
        assert.ok(!r.error.includes(SECRET_FILTER), `HTTP ${status}: the filter value never leaks into the error`);
        assert.ok(!r.error.includes(KEY) && !r.error.includes(ENV), `HTTP ${status}: credentials never leak into the error`);
    }

    // 303 is vPlan's maintenance redirect — treated as a failure, never followed.
    for (const status of [303, 503]) {
        scriptFetch([{ status, text: '<html>maintenance</html>' }]);
        const r = await executeVplanTool('vplan_whoami', {}, 'u1');
        assert.match(r.error, /temporarily unavailable/, `HTTP ${status} is reported as maintenance`);
        assert.ok(!r.error.includes('html'), 'the HTML body never reaches the model');
    }

    // ── 429 retries exactly once, then gives up ───────────────────────
    scriptFetch([
        { status: 429, headers: { 'RateLimit-Reset': '0' }, json: { errors: [{ message: 'slow down' }] } },
        { json: listBody([{ id: UUID, name: 'Board A' }]) },
    ]);
    const afterRetry = await executeVplanTool('vplan_list_boards', {}, 'u1');
    assert.strictEqual(afterRetry.count, 1, 'a rate-limited request is retried once and then succeeds');
    assert.strictEqual(fetchCalls.length, 2);

    scriptFetch([
        { status: 429, headers: { 'RateLimit-Reset': '0' }, json: { errors: [{ message: 'slow down' }] } },
        { status: 429, headers: { 'RateLimit-Reset': '0' }, json: { errors: [{ message: 'slow down' }] } },
    ]);
    const rateLimited = await executeVplanTool('vplan_list_boards', {}, 'u1');
    assert.match(rateLimited.error, /rate limit/);
    assert.strictEqual(fetchCalls.length, 2, 'no retry loop — exactly one retry');

    // ── transport failures ────────────────────────────────────────────
    global.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    assert.match((await executeVplanTool('vplan_whoami', {}, 'u1')).error, /timed out/);
    global.fetch = async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); };
    const unreachable = await executeVplanTool('vplan_whoami', {}, 'u1');
    assert.match(unreachable.error, /Could not reach vPlan/);
    assert.ok(!unreachable.error.includes(KEY), 'lower-level detail (which can carry credentials) is never surfaced');

    // ── unknown tool ──────────────────────────────────────────────────
    scriptFetch([]);
    assert.match((await executeVplanTool('vplan_create_card', {}, 'u1')).error, /Unknown vPlan tool/);
    assert.strictEqual(fetchCalls.length, 0);

    console.log('vplanTools.test.js — all checks passed');
})().catch(err => { console.error(err); process.exit(1); });

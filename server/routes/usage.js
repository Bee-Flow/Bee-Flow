/** @typedef {import('express-serve-static-core').NextFunction} NextFunction */
const express = require('express');
const router = express.Router();
const usageStore = require('../stores/usageStore');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds } = require('../auth');
const { computeCostSplit } = require('../core/llm/modelCosts');
const { validate } = require('../core/http/validate');
const { worded, queryOf, choice, wholeNumber } = require('../core/http/schemaParts');
const log = require('../telemetry/log');
const { isPlatformOperator } = require('../auth/platformOperator');

// ── What the usage dashboards may ask ────────────────────────────────
// Every route below reads its filters through buildRequestFilters (plus a
// handful of per-route keys), so ONE closed query covers the router. What it
// closes: `?days=abc` became 30 days under a 200; `?startDate=` without an
// end, or a date that is not a date, fell back to "last 30 days" or reached
// SQL as a 500; `?interval=hours` drew a daily chart; `?eu=yes` dropped the
// EU filter; a misspelled filter (`?modle=`) showed the unfiltered totals as
// if they were the filtered ones. `/recent` had no ceiling on `limit` at all.
const DATE_TEXT = 'startDate and endDate are dates, like 2026-09-01T00:00:00Z.';
const aDate = worded(DATE_TEXT).max(64, DATE_TEXT).refine((v) => !Number.isNaN(new Date(v).getTime()), DATE_TEXT);
/**
 * @param {string} name
 */
const filterText = (name) => worded(`${name} is text.`).max(200, `${name} is at most 200 characters.`);
const RECENT_MAX = 1000;
const UsageQuery = queryOf({
    days: wholeNumber('days is a whole number of days, 1 or more.', { min: 1, max: 36_500 }).optional(),
    startDate: aDate.optional(),
    endDate: aDate.optional(),
    user: filterText('user').optional(),
    agent: filterText('agent').optional(),
    model: filterText('model').optional(),
    source: filterText('source').optional(),
    integration: filterText('integration').optional(),
    pii: filterText('pii').optional(),
    type: filterText('type').optional(),
    interval: choice(['hour', 'day'], 'interval is hour or day.').optional(),
    // Each route clamps its own page size (see the handlers).
    limit: wholeNumber('limit is a whole number, 1 or more.', { min: 1 }).optional(),
    cursor: wholeNumber('cursor is the id the previous page ended at.', { min: 0 }).optional(),
    eu: choice(['true', 'false'], 'eu is true or false.').optional(),
    local: choice(['true', 'false'], 'local is true or false.').optional(),
    dimension: choice(['user', 'integration', 'agent', 'pii'], 'Invalid dimension. Use one of: user, integration, agent, pii').optional(),
}, 'The usage dashboard').refine((q) => !q.startDate === !q.endDate, {
    message: 'Send startDate and endDate together, or neither.', path: ['startDate'],
});

// Resolve the markup factor to apply when redacting customer-facing usage
// responses. Admin callers see raw figures; org / consumer callers see
// total_estimated_cost × (1 + markup_percent/100) and have token / message
// counts stripped from the payload.
// A failed lookup propagates (500): a 0% markup would show the customer the
// raw provider cost as if it were their bill.
async function getCustomerMarkup(req) {
    const orgIds = await resolveUserOrgIds(req);
    const sub = orgIds === null || orgIds.size === 0
        ? (req.session?.user?.id ? await userStore.getConsumerSubscription(req.session.user.id) : null)
        : await userStore.getOrgSubscription(Array.from(orgIds)[0]);
    if (!sub?.plan_id) return 0;
    const plan = await userStore.getPlan(sub.plan_id);
    return Number(plan?.markup_percent) || 0;
}

async function isAdminCaller(req) {
    // Privacy gate, not an operational permission: only the hardcoded
    // platform-operator account ("admin" credential from loginRoutes) sees
    // raw token/message counts and estimated_cost. Everyone else — org
    // admins, RBAC role-holders with `all`, every customer — gets the
    // redacted, marked-up cost-only view. Delegating this via the standard
    // hasPermission helper is a leak because `all` resolves any permission
    // query truthy, and org admins routinely receive `all` via their role.
    return isPlatformOperator(req.session?.user);
}

// The customer view of a row (allow-list, see usageCustomerView.js): usage*
// markup is the only AI figure customers see.
const { redactRow, redactRows } = require('./usageCustomerView');

// Apply customer redaction unless the caller is an admin. Use as the last
// step before res.json — returns the redacted payload (or the original).
/**
 * @param {string} kind
 */
async function maybeRedact(/** @type {import('express').Request} */ req, payload, kind) {
    // Self-hosted: no Stripe markup/reselling exists, so there's nothing to
    // redact — the operator sees raw tokens/cost. Redaction is purely a cloud
    // billing concern (serverLicenseGovernsOrgs() === self-hosted). The license
    // module is lazy-required (never at module top-level) to preserve boot
    // ordering — it pulls in heavy userStore DB init that must load after this
    // route module, not during it.
    const { serverLicenseGovernsOrgs } = require('../license');
    if (serverLicenseGovernsOrgs()) return payload;
    if (await isAdminCaller(req)) return payload;
    const markup = await getCustomerMarkup(req);
    const factor = 1 + markup / 100;
    if (kind === 'summary') return redactRow(payload, factor);
    if (kind === 'rows') return redactRows(payload, factor);
    return payload;
}

const { attachOrgFilter } = require('./usageScope');

// The session first, so an anonymous caller hears 401 rather than 400.
router.use((req, res, next) => (req.session?.isAuthenticated ? next() : res.status(401).json({ error: 'Not authenticated' })));
router.use(validate({ query: UsageQuery }));
router.use(attachOrgFilter);

// Monitoring dashboards (guardrail events + egress ledger) are org-admin-only
// and always exclude dry-run rows — see routes/usageMonitoringAuth.js for the
// full scope matrix. The consumption endpoints above/below stay member-readable.
const { requireMonitoringScope } = require('./usageMonitoringAuth');
router.use('/guardrails', requireMonitoringScope);
router.use('/integrations', requireMonitoringScope);

// ── Special categories (GDPR Art. 9) never next to a person ─────────────────
// Health labels (the Art. 9 kind the Shield detects) appear in these views as
// organisation-wide totals only: stripped from rows that carry a user,
// dropped from a category breakdown narrowed to one person, and a
// ?pii=<special category> filter never returns people. See
// core/privacy/specialCategories.js. Interim until per-person monitoring sits
// behind the works-council / notice / DPIA opt-in.
const { isSpecialCategory, withholdSpecialCategories, dropSpecialCategoryRows } = require('../core/privacy/specialCategories');
const { HttpError } = require('../core/http/errors');

/** The caller's own rows only (a personal account, or an admin filtering on themselves). */
function ownRowsOnly(req) {
    const userId = req.usageFilters?.userId;
    return !!userId && userId === req.session?.user?.id;
}

/** The answer is narrowed to one person who is not the caller. */
function aboutAnotherPerson(req) {
    return !!req.usageFilters?.userId && !ownRowsOnly(req);
}

/** Monitoring routes whose answer lists people: rows with a user, or a ranking of users. */
const PERSON_ROUTES = new Set(['/guardrails/recent', '/guardrails/by-user', '/integrations/recent', '/integrations/egress']);

router.use((req, res, next) => {
    if (!req.path.startsWith('/guardrails/') && !req.path.startsWith('/integrations/')) return next();
    if (!isSpecialCategory(req.query.pii) || ownRowsOnly(req)) return next();
    const listsPeople = PERSON_ROUTES.has(req.path)
        || (req.path === '/integrations/sovereignty' && (req.query.dimension || 'user') === 'user');
    if (aboutAnotherPerson(req) || listsPeople) {
        return next(new HttpError(400, 'special_category_per_person',
            'Health categories are shown as organisation totals only, never per person. Remove the person or the category filter.'));
    }
    next();
});

// Helper to load user display info (name + avatar) for usage rendering.
// Returns Map<userId, { display_name, avatarType, avatar }>.
/**
 * The avatar a monitoring row may carry inline: a short URL (an uploaded
 * picture is stored as `/uploads/<file>`) or an emoji. Never an inline image.
 *
 * `withUser` copies the avatar onto EVERY row it enriches, and the ledgers
 * answer up to 200 rows each. One account with a 2.2 MB base64 picture in its
 * avatar column turned the two detail responses of "What happened" into more
 * than 100 MB of JSON: stringifying that stalled the event loop for seconds
 * (every other query in flight "took" the same seconds, and the pool reported
 * a connect timeout), and the browser then downloaded and parsed it all.
 * The same 2048-character rule as projects.js memberAvatar.
 */
const INLINE_AVATAR_MAX_CHARS = 2048;
function inlineAvatar(avatar) {
    return typeof avatar === 'string' && avatar.length > 0 && avatar.length <= INLINE_AVATAR_MAX_CHARS ? avatar : null;
}

function userEntry(u) {
    return {
        display_name: u.displayName || u.username || u.id,
        avatarType: u.avatarType || null,
        avatar: inlineAvatar(u.avatar),
    };
}

async function getUserMap() {
    try {
        const userStore = require('../stores/userStore');
        const allUsers = await userStore.getAllUserAvatars();
        const map = new Map();
        for (const u of allUsers) map.set(u.id, userEntry(u));
        return map;
    } catch { return new Map(); }
}

// Targeted variant: only the users that actually appear in the rows. The
// full-table getUserMap() above was called by FIVE monitoring endpoints per
// dashboard load — a whole-`users`-table scan (avatars included) each time.
// Accepts rows or an iterable of ids; returns the same Map shape.
/**
 * @param {string} [idField]
 */
async function getUserMapFor(rowsOrIds, idField = 'user_id') {
    try {
        const ids = new Set();
        for (const item of rowsOrIds || []) {
            const id = typeof item === 'string' ? item : item?.[idField];
            if (id) ids.add(id);
        }
        if (ids.size === 0) return new Map();
        const userStore = require('../stores/userStore');
        const users = await userStore.getUserAvatarsByIds([...ids]);
        const map = new Map();
        for (const u of users) map.set(u.id, userEntry(u));
        return map;
    } catch { return new Map(); }
}

// Spread a userMap entry onto a row (display_name + avatar fields).
function withUser(row, userMap) {
    const info = userMap.get(row.user_id);
    return {
        ...row,
        display_name: info?.display_name || row.user_id || 'Unknown',
        avatarType: info?.avatarType || null,
        avatar: info?.avatar || null,
    };
}

// Helper: enrich model-level rows with input/output cost split
function enrichWithCostSplit(rows) {
    return (rows || []).map(row => {
        const { input_cost, output_cost } = computeCostSplit(row.model, row.prompt_tokens || 0, row.completion_tokens || 0, row.cached_tokens || 0, row.cache_creation_tokens || 0);
        return { ...row, input_cost, output_cost };
    });
}

// 1. Summary Overview (enriched with input/output cost + Azure service costs)
router.get('/summary', async (req, res) => {
    const summary = await usageStore.getUsageSummary(req.usageFilters);
    // Compute aggregated input/output costs from per-model data
    const modelData = await usageStore.getUsageByModel(req.usageFilters);
    let total_input_cost = 0, total_output_cost = 0;
    for (const m of (modelData || [])) {
        const { input_cost, output_cost } = computeCostSplit(m.model, m.prompt_tokens || 0, m.completion_tokens || 0, m.cached_tokens || 0, m.cache_creation_tokens || 0);
        total_input_cost += input_cost;
        total_output_cost += output_cost;
    }
    // Fetch Azure service costs for the same period
    let azure_services_total_cost = 0;
    try {
        const azSvcStore = require('../stores/azureServiceUsageStore');
        const azSummary = await azSvcStore.getAzureServiceSummary(req.usageFilters);
        azure_services_total_cost = azSummary?.total_cost || 0;
    } catch (_) { log.warn('Azure service usage summary failed, reporting zero cost', _); }
    const fullPayload = {
        ...(summary || { total_calls: 0, total_tokens: 0, total_estimated_cost: 0, total_prompt_tokens: 0, total_completion_tokens: 0 }),
        total_input_cost,
        total_output_cost,
        azure_services_total_cost,
        combined_total_cost: (summary?.total_estimated_cost || 0) + azure_services_total_cost,
    };
    res.json(await maybeRedact(req, fullPayload, 'summary'));
});

// 2. Timeline (supports ?interval=hour|day from frontend)
router.get('/timeline', async (req, res) => {
    const interval = req.query.interval === 'hour' ? 'hour' : 'day';
    const timeline = await usageStore.getUsageTimeline(req.usageFilters, interval);
    res.json(await maybeRedact(req, timeline || [], 'rows'));
});

// 3. Cost Timeline
router.get('/cost-timeline', async (req, res) => {
    const interval = req.query.interval === 'hour' ? 'hour' : 'day';
    const data = await usageStore.getCostTimeline(req.usageFilters, interval);
    res.json(await maybeRedact(req, data || [], 'rows'));
});

// 4. Usage by User
router.get('/users', async (req, res) => {
    const usersUsage = await usageStore.getUsageByUser(req.usageFilters);
    const userMap = await getUserMap();
    res.json(await maybeRedact(req, (usersUsage || []).map(u => withUser(u, userMap)), 'rows'));
});
// Alias: frontend calls /by-user
router.get('/by-user', async (req, res) => {
    const usersUsage = await usageStore.getUsageByUser(req.usageFilters);
    const userMap = await getUserMap();
    res.json(await maybeRedact(req, (usersUsage || []).map(u => withUser(u, userMap)), 'rows'));
});

// 5. Usage by App Area (Source)
router.get('/sources', async (req, res) => {
    const sources = await usageStore.getUsageBySource(req.usageFilters);
    res.json(await maybeRedact(req, sources || [], 'rows'));
});

// 6. Usage by Agent
router.get('/agents', async (req, res) => {
    const agents = await usageStore.getUsageByAgent(req.usageFilters);
    res.json(await maybeRedact(req, enrichWithCostSplit(agents), 'rows'));
});
// Alias: frontend calls /by-agent
router.get('/by-agent', async (req, res) => {
    const agents = await usageStore.getUsageByAgent(req.usageFilters);
    res.json(await maybeRedact(req, enrichWithCostSplit(agents), 'rows'));
});

// 7. Usage by Model (with input/output cost)
router.get('/models', async (req, res) => {
    const models = await usageStore.getUsageByModel(req.usageFilters);
    res.json(await maybeRedact(req, enrichWithCostSplit(models), 'rows'));
});
// Alias: frontend calls /by-model
router.get('/by-model', async (req, res) => {
    const models = await usageStore.getUsageByModel(req.usageFilters);
    res.json(await maybeRedact(req, enrichWithCostSplit(models), 'rows'));
});

// 8. Usage by Conversation
router.get('/by-conversation', async (req, res) => {
    const data = await usageStore.getUsageByConversation(req.usageFilters);
    res.json(await maybeRedact(req, data || [], 'rows'));
});

// Per-swarm-run roll-up: tokens + cost grouped by swarm_run_id, with the
// orchestrator vs. worker split derived from parent_call_id.
router.get('/by-swarm-run', async (req, res) => {
    const data = await usageStore.getUsageBySwarmRun(req.usageFilters);
    res.json(await maybeRedact(req, data || [], 'rows'));
});

// 9. Tool usage
router.get('/tools', async (req, res) => {
    const tools = await usageStore.getToolUsage(req.usageFilters);
    res.json(await maybeRedact(req, tools || [], 'rows'));
});

// 10. Recent calls
router.get('/recent', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, RECENT_MAX);
    const data = await usageStore.getRecentCalls(limit, req.usageFilters);
    res.json(await maybeRedact(req, data || [], 'rows'));
});

// 11. Filter options: distinct sources
router.get('/filters/sources', async (req, res) => {
    const sources = await usageStore.getUsageSources();
    res.json(sources || []);
});

// 12. Filter options: distinct models
router.get('/filters/models', async (req, res) => {
    const models = await usageStore.getUsageModels();
    res.json(models || []);
});

// 13. Organizations usage summary
router.get('/organizations', async (req, res) => {
    // Return empty array — org-level breakdown is only for multi-tenant setups
    res.json([]);
});

// 14. Model × Agent breakdown (with input/output cost)
router.get('/models-by-agent', async (req, res) => {
    const data = await usageStore.getUsageByModelAndAgent(req.usageFilters);
    res.json(await maybeRedact(req, enrichWithCostSplit(data), 'rows'));
});

// 15. Model × User breakdown (with input/output cost + display names)
router.get('/models-by-user', async (req, res) => {
    const data = await usageStore.getUsageByModelAndUser(req.usageFilters);
    const userMap = await getUserMap();
    res.json(await maybeRedact(req, enrichWithCostSplit(data).map(row => withUser(row, userMap)), 'rows'));
});

// ════════════════════════════════════════════════════════════════════════════
// GUARDRAIL / SAFETY MONITORING ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════
const guardrailEventStore = require('../stores/guardrailEventStore');

// The granular endpoints below are superseded by the two consolidated
// /overview endpoints (one round-trip instead of 19) and kept ONE release for
// the transition — demo fixtures and any stale frontend keep working. They
// share the new authz + dry-run exclusion via the middleware above.
const DEPRECATED_MONITORING_PATHS = new Set([
    '/guardrails/summary', '/guardrails/timeline', '/guardrails/by-user',
    '/guardrails/by-category', '/guardrails/by-action',
    '/integrations/summary', '/integrations/timeline', '/integrations/by-type',
    '/integrations/by-tool', '/integrations/pii-summary', '/integrations/servers',
    '/integrations/recent', '/integrations/operator-summary', '/integrations/sovereignty',
]);
router.use((req, res, next) => {
    if (DEPRECATED_MONITORING_PATHS.has(req.path)) res.set('Deprecation', 'true');
    next();
});

// Consolidated overview — everything the Privacy Shield Activity tab renders,
// in one response per domain.
router.get('/guardrails/overview', async (req, res) => {
    const interval = req.query.interval === 'hour' ? 'hour' : 'day';
    const data = await guardrailEventStore.getGuardrailOverview(req.usageFilters, interval);
    // Art. 9: no health categories in one other person's breakdown, and a
    // special-category filter returns no ranking of people.
    if (aboutAnotherPerson(req)) data.top_categories = dropSpecialCategoryRows(data.top_categories);
    if (isSpecialCategory(req.query.pii) && !ownRowsOnly(req)) data.top_users = [];
    const userMap = await getUserMapFor(data.top_users);
    data.top_users = (data.top_users || []).map(row => withUser(row, userMap));
    data.window = {
        start: req.usageFilters.startDate || null,
        end: req.usageFilters.endDate || null,
        interval,
    };
    res.json(data);
});

// 16. Guardrail Summary
router.get('/guardrails/summary', async (req, res) => {
    const summary = await guardrailEventStore.getGuardrailSummary(req.usageFilters);
    res.json(summary || { total_events: 0, moderation_count: 0, pii_count: 0, regex_count: 0, input_count: 0, output_count: 0, unique_users: 0 });
});

// 17. Guardrail Timeline
router.get('/guardrails/timeline', async (req, res) => {
    const interval = req.query.interval === 'hour' ? 'hour' : 'day';
    const timeline = await guardrailEventStore.getGuardrailTimeline(req.usageFilters, interval);
    res.json(timeline || []);
});

// 18. Guardrail Events by User
router.get('/guardrails/by-user', async (req, res) => {
    const data = await guardrailEventStore.getGuardrailByUser(req.usageFilters);
    const userMap = await getUserMapFor(data);
    res.json((data || []).map(row => withUser(row, userMap)));
});

// 19. Guardrail Events by Category
router.get('/guardrails/by-category', async (req, res) => {
    const data = await guardrailEventStore.getGuardrailByCategory(req.usageFilters);
    // Art. 9: one other person's breakdown carries no health categories.
    res.json(aboutAnotherPerson(req) ? dropSpecialCategoryRows(data) : (data || []));
});

// 20. Recent Guardrail Events
router.get('/guardrails/recent', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const filters = { ...req.usageFilters };
    const beforeId = parseInt(req.query.cursor, 10);
    if (Number.isFinite(beforeId)) filters.beforeId = beforeId;
    if (req.query.type) filters.violationType = req.query.type;
    // Art. 9: every row carries a person, so no health categories on it
    // (unless the rows are the caller's own). A page can come back shorter
    // than `limit`; the cursor of its last row still pages correctly.
    const raw = await guardrailEventStore.getRecentGuardrailEvents(limit, filters);
    const data = ownRowsOnly(req) ? raw : withholdSpecialCategories(raw, 'violation_categories');
    const userMap = await getUserMapFor(data);
    // Response stays a plain array (existing consumers). Keyset paging:
    // pass ?cursor=<id of the last row you have> to get strictly older
    // rows — the client derives the cursor from the last row's id.
    res.json((data || []).map(row => withUser(row, userMap)));
});

// 21. Guardrail Events by Action Taken
router.get('/guardrails/by-action', async (req, res) => {
    const data = await guardrailEventStore.getGuardrailByAction(req.usageFilters);
    res.json(data || []);
});

// ════════════════════════════════════════════════════════════════════════════
// INTEGRATION ACTIVITY MONITORING ENDPOINTS (Data Sovereignty)
// ════════════════════════════════════════════════════════════════════════════
const integrationActivityStore = require('../stores/integrationActivityStore');
const { countryFlag } = require('../stores/serverGeoResolver');
const { normalizeCategory } = require('../core/privacy/piiCategories');

// Consolidated overview — includes the SERVER-side sovereignty score computed
// over full aggregates. The old dashboard derived its headline score
// client-side from a 200-row egress sample, silently wrong for busy orgs.
// The `map` block (origin, every destination with its location, the DB-IP
// attribution and the location database's status) feeds "Where your data went".
router.get('/integrations/overview', async (req, res) => {
    const interval = req.query.interval === 'hour' ? 'hour' : 'day';
    const data = await integrationActivityStore.getIntegrationOverview(req.usageFilters, interval, { normalizeCategory });
    // Art. 9: see the guardrails overview.
    if (aboutAnotherPerson(req)) data.pii_categories = dropSpecialCategoryRows(data.pii_categories);
    if (isSpecialCategory(req.query.pii) && !ownRowsOnly(req)) data.top.users = [];
    const userMap = await getUserMapFor(data.top.users);
    data.top.users = (data.top.users || []).map(row => withUser(row, userMap));
    for (const row of [...(data.top.destinations || []), ...(data.map?.destinations || [])]) {
        row.country_flag = countryFlag(row.country_code);
    }
    data.window = {
        start: req.usageFilters.startDate || null,
        end: req.usageFilters.endDate || null,
        interval,
    };
    res.json(data);
});

// 21. Integration Summary
router.get('/integrations/summary', async (req, res) => {
    const summary = await integrationActivityStore.getIntegrationSummary(req.usageFilters);
    res.json(summary || { total_calls: 0, unique_integrations: 0, unique_servers: 0, sent_count: 0, received_count: 0, pii_events: 0, unique_users: 0 });
});

// 22. Integration Timeline
router.get('/integrations/timeline', async (req, res) => {
    const interval = req.query.interval === 'hour' ? 'hour' : 'day';
    const timeline = await integrationActivityStore.getIntegrationTimeline(req.usageFilters, interval);
    res.json(timeline || []);
});

// 23. Integration by Type
router.get('/integrations/by-type', async (req, res) => {
    const data = await integrationActivityStore.getIntegrationByType(req.usageFilters);
    res.json(data || []);
});

// 24. Integration by Tool
router.get('/integrations/by-tool', async (req, res) => {
    const data = await integrationActivityStore.getIntegrationByTool(req.usageFilters);
    res.json(data || []);
});

// 25. Integration PII Summary
router.get('/integrations/pii-summary', async (req, res) => {
    const data = await integrationActivityStore.getIntegrationPiiSummary(req.usageFilters);
    res.json(aboutAnotherPerson(req) ? dropSpecialCategoryRows(data, 'pii_category') : (data || []));
});

// 26. Integration Servers / Endpoints (geo data is pre-resolved in the DB)
router.get('/integrations/servers', async (req, res) => {
    const data = await integrationActivityStore.getIntegrationServers(req.usageFilters);
    // Add flag emojis for all observed country codes
    for (const row of (data || [])) {
        row.country_flags = (row.country_codes || []).map(c => countryFlag(c));
    }
    res.json(data || []);
});

// 27. Recent Integration Activity (geo data is pre-resolved in the DB)
router.get('/integrations/recent', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const raw = await integrationActivityStore.getRecentIntegrationActivity(limit, req.usageFilters);
    // Art. 9: no health categories on a row that carries a person.
    const data = ownRowsOnly(req) ? raw : withholdSpecialCategories(raw, 'pii_categories_detected');
    const userMap = await getUserMapFor(data);
    const enriched = (data || []).map(row => ({
        ...withUser(row, userMap),
        country_flag: countryFlag(row.country_code),
    }));
    res.json(enriched);
});

// Per-call data egress log — the authoritative "where did the data go" view.
// Each row corresponds to one tool call; peer_ip is the address the connection
// actually went to (core/http/egressCapture.js), and the location fields say
// where that is (core/http/geo/locate.js).
router.get('/integrations/egress', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const euOnly = req.query.eu === 'true' ? true : req.query.eu === 'false' ? false : undefined;
    const localOnly = req.query.local === 'true';
    // ?state=local|eu|outside|via_network|unknown (the store ignores anything else).
    const locationState = typeof req.query.state === 'string' ? req.query.state : undefined;
    const filters = { ...req.usageFilters, euOnly, localOnly, locationState };
    // Keyset paging: ?cursor=<last row id> returns strictly older rows.
    const beforeId = parseInt(req.query.cursor, 10);
    if (Number.isFinite(beforeId)) filters.beforeId = beforeId;
    const raw = await integrationActivityStore.getEgressLog(filters, limit);
    // Art. 9: no health categories on a row that carries a person.
    const data = ownRowsOnly(req) ? raw : withholdSpecialCategories(raw, 'pii_categories_detected');
    const userMap = await getUserMapFor(data);
    const enriched = (data || []).map(row => ({
        ...withUser(row, userMap),
        country_flag: countryFlag(row.country_code),
    }));
    res.json(enriched);
});

// Operator summary — grouped by cloud / hosting company (Google / Microsoft /
// Cloudflare / AWS / …). Unknown IPs surface as "Unknown" rather than being hidden.
router.get('/integrations/operator-summary', async (req, res) => {
    const data = await integrationActivityStore.getOperatorSummary(req.usageFilters);
    res.json(data || []);
});

// Thin alias: agent-hub/src/api/queries/usage.ts referenced this path for
// years while no such route existed (silent 404). Deprecated from birth —
// the data is the overview's `health` block.
router.get('/integrations-health', requireMonitoringScope, async (req, res) => {
    res.set('Deprecation', 'true');
    const data = await integrationActivityStore.getIntegrationOverview(req.usageFilters, 'day');
    res.json(data.health);
});

// Sovereignty breakdown by dimension (user / integration / agent / pii).
// Each row shape is uniform — the frontend renders all four with one template.
router.get('/integrations/sovereignty', async (req, res) => {
    const dimension = req.query.dimension || 'user';
    if (!['user', 'integration', 'agent', 'pii'].includes(dimension)) {
        return res.status(400).json({ error: `Invalid dimension. Use one of: user, integration, agent, pii` });
    }
    const found = await integrationActivityStore.getSovereigntyByDimension(dimension, req.usageFilters);
    // Art. 9: one other person's category breakdown carries no health categories.
    const data = dimension === 'pii' && aboutAnotherPerson(req) ? dropSpecialCategoryRows(found, 'key') : found;
    // Hydrate user display names + avatars for the 'user' dimension so the
    // UI can render an Avatar with a real label instead of a raw user_id.
    if (dimension === 'user') {
        const userMap = await getUserMapFor(data, 'key');
        const enriched = (data || []).map(row => {
            const u = userMap.get(row.key) || {};
            return {
                ...row,
                label: u.display_name || row.label,
                avatar: u.avatar || null,
                avatarType: u.avatarType || null,
            };
        });
        return res.json(enriched);
    }
    res.json(data || []);
});

module.exports = router;

// ════════════════════════════════════════════════════════════════════════════
// AZURE SERVICE COST MONITORING ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════
const azureServiceUsageStore = require('../stores/azureServiceUsageStore');

// 28. Azure Service Summary
router.get('/azure-services/summary', async (req, res) => {
    const summary = await azureServiceUsageStore.getAzureServiceSummary(req.usageFilters);
    res.json(summary || { total_calls: 0, total_cost: 0, total_pages: 0, total_chars: 0, total_tokens: 0, unique_services: 0, unique_users: 0 });
});

// 29. Azure Service by Type
router.get('/azure-services/by-type', async (req, res) => {
    const data = await azureServiceUsageStore.getAzureServiceByType(req.usageFilters);
    res.json(data || []);
});

// 30. Azure Service by User
router.get('/azure-services/by-user', async (req, res) => {
    const data = await azureServiceUsageStore.getAzureServiceByUser(req.usageFilters);
    const userMap = await getUserMap();
    res.json((data || []).map(row => withUser(row, userMap)));
});

// 31. Azure Service Timeline
router.get('/azure-services/timeline', async (req, res) => {
    const interval = req.query.interval === 'hour' ? 'hour' : 'day';
    const data = await azureServiceUsageStore.getAzureServiceTimeline(req.usageFilters, interval);
    res.json(data || []);
});

// 32. Recent Azure Service Usage
router.get('/azure-services/recent', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, RECENT_MAX);
    const data = await azureServiceUsageStore.getRecentAzureServiceUsage(limit, req.usageFilters);
    const userMap = await getUserMap();
    res.json((data || []).map(row => withUser(row, userMap)));
});

// 33. Azure Service Cost Rates (current pricing config)
router.get('/azure-services/rates', async (req, res) => {
    const { getAllRates } = require('../core/llm/azureServiceCosts');
    res.json(getAllRates());
});


// 34. Prompt-cache hit rate (+ week-over-week delta)
//
// Anthropic's prompt cache is a prefix match: a system prompt or tool list that
// drifts between turns drops the hit rate to zero AND makes every request pay a
// full-price cache write (2x at a 1h TTL). Nothing in the product surfaces that
// — it lands on the bill weeks later. This endpoint makes it observable, and
// `alert` is what a monitor should key on.
//
// Admin-only: the payload is token counts, which the customer-facing views
// deliberately strip.
router.get('/prompt-cache', async (req, res) => {
    if (!(await isAdminCaller(req))) {
        return res.status(403).json({ error: 'Admin only' });
    }
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const scope = { ...req.usageFilters };
    delete scope.startDate;
    delete scope.endDate;

    /**
     * @param {number} endMs
     */
    const window = (endMs) => ({
        ...scope,
        startDate: new Date(endMs - WEEK_MS).toISOString(),
        endDate: new Date(endMs).toISOString(),
    });

    const [breakdown, current, previous] = await Promise.all([
        usageStore.getPromptCacheStats(window(now)),
        usageStore.getPromptCacheHitRate(window(now)),
        usageStore.getPromptCacheHitRate(window(now - WEEK_MS)),
    ]);

    const curRate = Number(current?.hit_rate) || 0;
    const prevRate = Number(previous?.hit_rate) || 0;
    // Relative drop, which is how Anthropic's own console alert phrases it
    // ("dropped 31% compared with the previous week"). Only meaningful once
    // the prior week actually used the cache.
    const relativeDrop = prevRate > 0 ? (prevRate - curRate) / prevRate : 0;
    const ALERT_THRESHOLD = 0.15;

    res.json({
        current_week: { ...current, hit_rate: curRate },
        previous_week: { ...previous, hit_rate: prevRate },
        relative_change: prevRate > 0 ? (curRate - prevRate) / prevRate : null,
        alert: prevRate > 0 && relativeDrop >= ALERT_THRESHOLD
            ? {
                severity: relativeDrop >= 0.3 ? 'critical' : 'warning',
                message: `Prompt cache hit rate fell ${Math.round(relativeDrop * 100)}% week-over-week `
                    + `(${(prevRate * 100).toFixed(1)}% → ${(curRate * 100).toFixed(1)}%). `
                    + `Check for per-turn content in the first system block or a tool list that changes mid-conversation.`,
            }
            : null,
        by_model_and_source: breakdown || [],
    });
});

/**
 * @typedef {{ startDate?: string,
 *   endDate?: string,
 *   userId?: string,
 *   agentId?: string,
 *   model?: string,
 *   source?: string,
 *   integrationType?: string,
 *   piiCategory?: string,
 *   organizationId?: string,
 *   beforeId?: number,
 *   violationType?: string }} UsageFilters
 */

/**
 * Request after attachOrgFilter. The query passed the closed UsageQuery schema, so every value is a string.
 * @typedef {import('express').Request<{}, any, any, Record<string, string>> & { usageFilters: UsageFilters }} UsageReq
 */

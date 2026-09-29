/**
 * Per-user Nextcloud access scope API — the settings surface behind
 * "What Bee Flow may access" (Settings → Integrations → Nextcloud).
 *
 * Self-service only in v1: a user reads and writes their OWN scope. The org
 * ceiling (org_nc_scope_<orgId>) is composed by the resolver but has no
 * write surface yet. Storage/validation/audit live in
 * core/integrations/ncScope.js; enforcement lives in
 * core/integrations/ncScopeGuard.js (toolDispatcher) — this route is
 * configuration, never authorization.
 *
 * The /resources/:integrationId picker endpoint runs the family's list tool
 * through the NORMAL executor (so connector, OAuth and app-password modes
 * all work) and is deliberately NOT scope-filtered: the picker must show
 * everything the user's own Nextcloud account can see, so they can re-widen
 * their own narrowing. The org ceiling still binds at call time.
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');

const { requireAuth } = require('../auth/permissions');
const ncScope = require('../core/integrations/ncScope');
const { NC_INTEGRATIONS } = require('../core/integrations/ncIntegrationCatalog');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

// ── What a caller may send ──────────────────────────────────────────
//
// This is the screen where somebody tells Bee Flow what it may NOT touch in
// their Nextcloud, and core/integrations/ncScope.js drops whatever it does
// not recognise — the right call for a stored document, and a silent no-op
// for a request. Each of these answered 200 with the scope unchanged:
//
//   - a misspelled app id (`nextcloud-calender`) — the calendar stayed open;
//   - a misspelled mode (`Off`, `none`) — the app the user switched off
//     stayed on;
//   - `integration` without the s — nothing saved at all;
//   - a folder that is not a path inside Nextcloud (`../x`) was dropped from
//     the selection, and a selection past 200 was cut to 200.
//
// And two that changed the scope into something nobody asked for:
//
//   - `mode: 'selected'` on an app that cannot be narrowed was stored as
//     'off' — the opposite of "only these";
//   - POST /reset with `{ integrationId: 'nextcloud' }` reset EVERY app to
//     "everything": access widened to all of Nextcloud for someone who meant
//     one app. /reset and /revoke-all take no body now.
//
// `null` for an app still means "back to everything", as the core documents.
// The core keeps its own fail-closed coercion for stored documents.

/** The core's cap per app (MAX_SELECTED in core/integrations/ncScope.js). */
const MAX_SELECTED = 200;
const MAX_ID_LEN = 500;

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { invalid_type_error: 'Send the settings as a JSON object.' }).strict(),
);

const MODE_TEXT = "mode is 'all', 'selected' or 'off'.";
const Entry = z.object({
    mode: z.enum(['all', 'selected', 'off'], { errorMap: () => ({ message: MODE_TEXT }) }),
    selected: z.array(
        z.union([z.string(), z.number()], { errorMap: () => ({ message: 'Each selection is an id or a folder path.' }) }),
        { invalid_type_error: 'selected is a list.' },
    ).optional(),
}, { invalid_type_error: 'Each app is { mode, selected }, or null for everything.' }).strict().nullable();

const INTEGRATIONS_TEXT = 'integrations maps a Nextcloud app to its access, like { "nextcloud-calendar": { "mode": "off" } }.';
const ScopeBody = bodyOf({
    integrations: z.object(
        Object.fromEntries(NC_INTEGRATIONS.map(({ id }) => [id, Entry.optional()])),
        { required_error: INTEGRATIONS_TEXT, invalid_type_error: INTEGRATIONS_TEXT },
    ).strict().superRefine((integrations, ctx) => {
        for (const [id, entry] of Object.entries(integrations)) {
            if (!entry || entry.mode !== 'selected') continue;
            const { name } = NC_INTEGRATIONS.find((i) => i.id === id);
            if (!ncScope.isScopable(id)) {
                ctx.addIssue({ code: 'custom', path: [id, 'mode'], message: `${name} cannot be narrowed to a selection — choose all or off.` });
                continue;
            }
            const list = entry.selected || [];
            const { label } = ncScope.RESOURCE_KINDS[id];
            if (list.length > MAX_SELECTED) {
                ctx.addIssue({ code: 'custom', path: [id, 'selected'], message: `At most ${MAX_SELECTED} ${label} can be selected.` });
            }
            list.forEach((item, i) => {
                const ok = id === 'nextcloud'
                    ? ncScope.normalizeFolderPath(item) !== null
                    : String(item).trim() !== '' && String(item).trim().length <= MAX_ID_LEN;
                if (!ok) {
                    ctx.addIssue({
                        code: 'custom', path: [id, 'selected', i],
                        message: id === 'nextcloud' ? 'A folder is a path inside your Nextcloud, like /Projects.' : `Each selected item is one of your ${label}.`,
                    });
                }
            });
        }
    }),
});

const ResourcesQuery = z.object({
    path: worded('path is one folder path, like /Projects.').optional(),
}).strict();

/** Revoke-all and reset act on every app at once; a per-app option would be ignored. */
const NoBody = bodyOf({});

function callerOrgId(req) {
    return req.session?.connectorOrgId || req.session?.user?.organizationId || null;
}

function presentScope(doc) {
    const integrations = {};
    const stored = ncScope.sanitizeIntegrations(doc?.integrations);
    for (const { id, name, description } of NC_INTEGRATIONS) {
        const entry = stored[id] || { mode: 'all' };
        integrations[id] = {
            name,
            description,
            mode: entry.mode,
            selected: entry.mode === 'selected' ? (entry.selected || []) : [],
            scopable: ncScope.isScopable(id),
            resource: ncScope.RESOURCE_KINDS[id] || null,
        };
    }
    return integrations;
}

router.get('/', requireAuth, async (req, res) => {
    try {
        const doc = await ncScope.getUserScopeDoc(req.session.user.id);
        res.json({ integrations: presentScope(doc), updatedAt: doc?.updatedAt || null });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load Nextcloud access settings' });
    }
});

router.put('/', requireAuth, express.json({ limit: '256kb' }), validate({ body: ScopeBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const doc = await ncScope.saveUserScope(userId, { integrations: req.body.integrations }, {
            orgId: callerOrgId(req),
            updatedBy: userId,
        });
        _invalidateGuardCache(userId);
        res.json({ integrations: presentScope(doc), updatedAt: doc.updatedAt });
    } catch (e) {
        res.status(500).json({ error: 'Failed to save Nextcloud access settings' });
    }
});

// One-click offboarding: every integration explicitly off.
router.post('/revoke-all', requireAuth, validate({ body: NoBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const doc = await ncScope.revokeAll(userId, { orgId: callerOrgId(req), updatedBy: userId });
        _invalidateGuardCache(userId);
        res.json({ integrations: presentScope(doc), updatedAt: doc.updatedAt, revoked: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to revoke Nextcloud access' });
    }
});

// Back to the allow-all default (delete the doc).
router.post('/reset', requireAuth, validate({ body: NoBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const doc = await ncScope.resetToDefault(userId, { orgId: callerOrgId(req), updatedBy: userId });
        _invalidateGuardCache(userId);
        res.json({ integrations: presentScope(doc), updatedAt: null, reset: true });
    } catch (e) {
        res.status(500).json({ error: 'Failed to reset Nextcloud access settings' });
    }
});

function _invalidateGuardCache(userId) {
    try {
        require('../core/integrations/ncScopeGuard').invalidateScopeCache(userId);
    } catch (_) { /* guard cache is 15s anyway */ }
}

// ── Resource discovery for the pickers ──────────────────────────────────────

const resourceLimiter = rateLimit({
    windowMs: 60_000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `ncscope:${req.session?.user?.id || req.ip}`,
});

// 60s per-user cache — opening the flyout re-lists; Nextcloud need not be
// asked twice per minute for the same catalogue.
const _resourceCache = new Map();
const RESOURCE_CACHE_TTL_MS = 60_000;

router.get('/resources/:integrationId', requireAuth, resourceLimiter, validate({ query: ResourcesQuery }), async (req, res) => {
    const { integrationId } = req.params;
    const spec = ncScope.RESOURCE_KINDS[integrationId];
    if (!spec) return res.status(404).json({ error: 'This integration has no selectable resources' });

    const userId = req.session.user.id;
    const path = integrationId === 'nextcloud' ? (req.query.path || '/') : null;
    const cacheKey = `${userId}|${integrationId}|${path || ''}`;
    const hit = _resourceCache.get(cacheKey);
    if (hit && Date.now() - hit.at < RESOURCE_CACHE_TTL_MS) return res.json(hit.data);

    try {
        const { executeNextcloudFamilyTool } = require('../core/tools/toolDispatcher');
        let data;
        if (integrationId === 'nextcloud') {
            // Folder picker: one PROPFIND level per expansion (lazy tree).
            const result = await executeNextcloudFamilyTool('nextcloud_list_files', { path }, userId, req.session);
            if (result?.error) return res.status(502).json({ error: result.error });
            // nextcloud_list_files → { path, count, items: [{ name, path,
            // type: 'folder'|'file', … }] } (parsePropfind).
            const items = (result?.items || [])
                .filter(f => f?.type === 'folder')
                .map(f => ({ id: f.path, label: f.name, hasChildren: true }));
            data = { kind: spec.kind, path: result?.path || path, resources: items };
        } else {
            const result = await executeNextcloudFamilyTool(spec.listTool, {}, userId, req.session);
            if (result?.error) return res.status(502).json({ error: result.error });
            const CONTAINERS = ['calendars', 'addressbooks', 'boards', 'rooms', 'conversations', 'lists', 'accounts', 'tables', 'forms'];
            const arr = Array.isArray(result) ? result
                : CONTAINERS.map(k => result?.[k]).find(Array.isArray) || [];
            const ID_FIELDS = ['slug', 'token', 'id', 'accountId'];
            const LABEL_FIELDS = ['displayName', 'displayname', 'name', 'title', 'label', 'emailAddress', 'summary'];
            const resources = arr.map(item => {
                const idField = ID_FIELDS.find(f => item?.[f] !== undefined && item?.[f] !== null);
                if (!idField) return null;
                const labelField = LABEL_FIELDS.find(f => typeof item?.[f] === 'string' && item[f]);
                return {
                    id: String(item[idField]),
                    label: labelField ? item[labelField] : String(item[idField]),
                    color: typeof item?.color === 'string' ? item.color : null,
                };
            }).filter(Boolean);
            data = { kind: spec.kind, resources };
        }
        _resourceCache.set(cacheKey, { at: Date.now(), data });
        res.json(data);
    } catch (e) {
        res.status(502).json({ error: 'Could not list Nextcloud resources — is your Nextcloud connection working?' });
    }
});

module.exports = router;

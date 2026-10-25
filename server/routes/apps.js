// @typecheck noImplicitAny
/**
 * Apps API Routes - CRUD for App Marketplace.
 *
 * Apps follow the same publish/audience model as agents and KBs: an app
 * belongs to an organisation and is optionally restricted to specific
 * groups within that organisation. The list and single-read endpoints
 * MUST filter by the caller's org/group membership — without this, a
 * published app from one tenant leaks (incl. its full code) to every
 * other tenant on the deployment.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * Both bodies are `.strict()` and typed, because the audience fields failed
 * WIDE. `sharedGroups: 'sales'` — one group, not a list — fell through the
 * `Array.isArray` gate and was stored as `[]`, which appStore reads as "the
 * whole organisation": an app meant for one group was published to everyone,
 * under `{ success: true }`. And POST ignored `isPublished` altogether (it
 * passed a hard-coded `true`), so a draft created with `isPublished: false`
 * was live for the whole organisation the moment it existed.
 *
 * PUT is a partial update now, like its two audience fields always were.
 * Every other field went straight to the UPDATE, so a PUT without
 * `description` or `thumbnail` wiped them, and one without `name` or `code`
 * (say, just `{ isPublished: false }`) hit their NOT NULL columns as a 500.
 */

const express = require('express');
const { z, typeError } = require('../utils/zod');
const { worded } = require('../core/http/schemaParts');
const log = require('../telemetry/log');
const router = express.Router();
const appStore = require('../stores/appStore');
const userStore = require('../stores/userStore');
const { resolveUserOrgIds, canSeePublished, resolveUserGroups } = require('../auth');
const { validate } = require('../core/http/validate');

const NAME_TEXT = 'An app needs a name.';
const CODE_TEXT = 'An app needs its code, as text.';
const GROUPS_TEXT = 'sharedGroups is a list of group ids — an empty list shares with the whole organisation.';

const APP_FIELDS = {
    description: worded('A description is text.').nullish(),
    thumbnail: worded('A thumbnail is text (a URL or data URI).').nullish(),
    // Not nullable: `null` is how a client says "I have no value", and the
    // store would read it as `[]` — the whole organisation. Widening an
    // audience takes the explicit empty list.
    sharedGroups: z.array(worded(GROUPS_TEXT).trim().min(1, GROUPS_TEXT), { error: typeError({ invalid: GROUPS_TEXT }) }).optional(),
    isPublished: z.boolean({ error: typeError({ invalid: 'isPublished is true or false.' }) }).optional(),
};

const BODY_TEXT = 'Send the app as { name, code }.';
const CreateAppBody = z.object({
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT),
    code: worded(CODE_TEXT).min(1, CODE_TEXT),
    ...APP_FIELDS,
}, { error: typeError({ required: BODY_TEXT, invalid: BODY_TEXT }) }).strict();

const UpdateAppBody = z.object({
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).optional(),
    code: worded(CODE_TEXT).min(1, CODE_TEXT).optional(),
    ...APP_FIELDS,
}, { error: typeError({ required: BODY_TEXT, invalid: BODY_TEXT }) }).strict();

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../auth/permissions');

// Build the audience entity shape that `canSeePublished` expects, mapping
// the apps schema (`created_by`) to the generic `owner_id` field.
/** @param {NonNullable<Awaited<ReturnType<typeof import('../stores/appStore').getApp>>>} app */
function asAudienceEntity(app) {
    return {
        owner_id: app.created_by,
        organization_id: app.organization_id,
        is_published: app.is_published,
        shared_groups: app.shared_groups,
    };
}

// GET /apps — list apps the current user is allowed to see
router.get('/', requireAuth, async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const userId = req.session.user.id;
    const orgIds = await resolveUserOrgIds(req);
    const userGroups = await resolveUserGroups(userId);
    const apps = await appStore.getPublishedAppsForUser(orgIds, userGroups, userId);
    res.json(apps);
});

// GET /apps/mine — list apps created by current user (drafts included)
router.get('/mine', requireAuth, async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const apps = await appStore.getAppsByUser(req.session.user.id);
    res.json(apps);
});

// GET /apps/:id — single-app read, audience-gated
router.get('/:id', requireAuth, async (/** @type {import('express').Request<{ id: string }>} */ req, /** @type {import('express').Response} */ res) => {
    const app = await appStore.getApp(req.params.id);
    if (!app) {
        return res.status(404).json({ error: 'App not found' });
    }
    const userId = req.session.user.id;
    const orgIds = await resolveUserOrgIds(req);
    const userGroups = await resolveUserGroups(userId);
    if (!canSeePublished(asAudienceEntity(app), { userId, orgIds, userGroups })) {
        return res.status(404).json({ error: 'App not found' });
    }
    res.json(app);
});

// POST /apps — create/publish a new app, scoped to the caller's org
router.post('/', requireAuth, validate({ body: CreateAppBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const { name, description, code, thumbnail, sharedGroups, isPublished } = req.body;
    const userId = req.session.user.id;
    const username = /** @type {string} */ (req.session.user.username) || userId;

    // Auto-assign the user's first organization. Apps without an org are
    // only visible to super admins, so the marketplace would feel broken
    // for the creator if we left it null.
    const orgIds = await resolveUserOrgIds(req);
    /** @type {string | null} */
    let assignOrgId = null;
    if (orgIds === null) {
        const user = await userStore.getUser(userId);
        assignOrgId = user?.organizationId || null;
    } else if (orgIds.size > 0) {
        assignOrgId = Array.from(orgIds)[0];
    }

    // Published unless the body says otherwise — the default this route
    // always had; a draft (`isPublished: false`) now stays one.
    const app = await appStore.createApp(
        name, description, code, userId, username, thumbnail ?? null, isPublished ?? true,
        assignOrgId,
        sharedGroups ?? []
    );
    log.info(`[Apps] Created app: ${name} by user ${username} in org ${assignOrgId || 'none'}`);
    res.status(201).json(app);
});

// PUT /apps/:id — update an app (owner only, must stay in same org)
router.put('/:id', requireAuth, validate({ body: UpdateAppBody }), async (/** @type {import('express').Request<{ id: string }>} */ req, /** @type {import('express').Response} */ res) => {
    const { name, description, code, thumbnail, isPublished, sharedGroups } = req.body;
    const appId = req.params.id;
    const userId = req.session.user.id;

    const existing = await appStore.getApp(appId);
    if (!existing) {
        return res.status(404).json({ error: 'App not found' });
    }
    if (existing.created_by !== userId) {
        return res.status(403).json({ error: 'Not authorized to update this app' });
    }

    // Defensive cross-org check: even if the owner moves orgs, they
    // shouldn't be able to keep editing apps that no longer belong to
    // any org they're a member of.
    const orgIds = await resolveUserOrgIds(req);
    if (orgIds !== null && existing.organization_id) {
        if (!(orgIds instanceof Set) || !orgIds.has(existing.organization_id)) {
            return res.status(403).json({ error: 'App belongs to an organisation you are no longer a member of' });
        }
    }

    // A field the body leaves out keeps its value; `null` clears the two
    // that may be empty. sharedGroups left out is preserved by the store.
    /**
     * @template T
     * @param {T | undefined} value
     * @param {T} current
     */
    const keep = (value, current) => (value === undefined ? current : value);
    const success = await appStore.updateApp(
        appId,
        keep(name, existing.name),
        keep(description, existing.description),
        keep(code, existing.code),
        keep(thumbnail, existing.thumbnail),
        keep(isPublished, existing.is_published),
        sharedGroups
    );
    if (success) {
        res.json({ success: true });
    } else {
        throw new Error('Failed to update app');
    }
});

// DELETE /apps/:id — delete an app (owner only)
router.delete('/:id', requireAuth, async (/** @type {import('express').Request<{ id: string }>} */ req, /** @type {import('express').Response} */ res) => {
    const appId = req.params.id;
    const existing = await appStore.getApp(appId);
    if (!existing) {
        return res.status(404).json({ error: 'App not found' });
    }
    if (existing.created_by !== req.session.user.id) {
        return res.status(403).json({ error: 'Not authorized to delete this app' });
    }

    const success = await appStore.deleteApp(appId);
    if (success) {
        log.info(`[Apps] Deleted app: ${appId}`);
        res.json({ success: true });
    } else {
        throw new Error('Failed to delete app');
    }
});

module.exports = router;

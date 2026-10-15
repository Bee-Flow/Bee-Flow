/**
 * App CRUD: list, mine, usage, create, read, ref, update, definition, delete
 *
 * (routes/studioApps/). The literal paths (/mine, /usage) are declared before
 * GET /:id in this file, and this router is mounted before the other /:id
 * parts (see ../studioApps.js). POST /import lives in ./appImport.
 */

const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const studioAppStore = require('../../stores/studioAppStore');
const { emptyDefinition, LIMITS } = require('../../appStudio/componentSpecs');
const { canonicalizeAppDefinition } = require('../../appStudio/canonicalize');
const { describeAppRef } = require('../../appStudio/appRefLookup');
const { validateAppDefinition } = require('../../appStudio/validate');
const { templateVersion } = require('../../appStudio/templates');
const { resolveTemplate, templateResolverFor } = require('../../appStudio/templateRegistry');
const { installTemplate } = require('../../appStudio/templateInstall');
const { hashDefinition, annotateTemplateUpgrades } = require('../../appStudio/templateUpgrade');
const studioAppQuota = require('../../appStudio/studioAppQuota');
const { DATA_LIMITS } = require('../../appStudio/dataModel');
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
// requirePrimaryOrgAdmin gates org-scoped read views on the CALLER's own org
// (org admin or super admin) and attaches req.primaryOrgId for the handler.
const { requireAuth, requirePrimaryOrgAdmin } = require('../../auth/permissions');
// "Show in the Nextcloud app menu" is served by the org's connector; these
// routes tell it to sync the moment the desired list changes, instead of
// leaving the owner to wait for its poll — see appStudio/nextcloudMenuSync.js.
const nextcloudMenuSync = require('../../appStudio/nextcloudMenuSync');
const { CreateAppBody, UpdateAppBody, DefinitionBody, RefQuery } = require('./schemas');
const { requireManageApps, audienceFor, refuseRead, resolveOwnerOrgId } = require('./access');
const { managedOf, MAX_CATEGORY_LEN, sanitizeAppRow, loadDataRefs } = require('./appHelpers');

const router = express.Router();

// ── App CRUD ────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
    const { userId, orgIdArr, userGroups } = await audienceFor(req);
    const apps = await studioAppStore.getAccessibleStudioApps(userId, userGroups, orgIdArr);
    res.json({ apps: apps.map(sanitizeAppRow) });
});

router.get('/mine', requireAuth, async (req, res) => {
    const { userId, orgIdArr } = await audienceFor(req);
    const apps = await studioAppStore.getStudioAppsByUser(req.session.user.id);
    // Attach a compact per-app storage usage field so the gallery can flag
    // apps nearing the DB cap (owner "Storage 82%" pill) without a second
    // fetch. dbRatio is server-computed so the client never needs the cap.
    // Best-effort: a size lookup hiccup drops usage, never the app list.
    let sizes = {};
    try { sizes = await studioAppQuota.appDbSizes(apps.map(a => a.id)); } catch (_) { /* usage optional */ }
    const cap = DATA_LIMITS.MAX_DB_BYTES;
    const withUsage = apps.map((a) => {
        const dbBytes = sizes[a.id] || 0;
        return {
            ...sanitizeAppRow(a),
            usage: { dbBytes, dbRatio: cap > 0 ? dbBytes / cap : 0 },
        };
    });
    // Per-app template-upgrade availability for the gallery's
    // "Update beschikbaar" affordance: { available, fromVersion?, toVersion? }.
    // Cheap — the definition is loaded and hashed ONLY for apps whose
    // registered template actually carries a newer version.
    const withUpgrades = await annotateTemplateUpgrades(withUsage, {
        loadApp: (id) => studioAppStore.getStudioApp(id),
        // Awaited by annotateTemplateUpgrades: a CAPTURED template is a
        // database row, and an app made from one gets the same "newer
        // version available" offer as an app made from a built-in.
        getTemplate: templateResolverFor({ userId, orgIds: orgIdArr }),
    });
    res.json({ apps: withUpgrades });
});

// ── Org-admin storage usage view ────────────────────────────────────
// Org totals + a per-app storage breakdown for the caller's own org. Gated on
// org-admin (or super admin) via requirePrimaryOrgAdmin, which resolves and
// attaches req.primaryOrgId. Read-only aggregate over Postgres facts (each
// app's SQLite db_size + the attachment ledger); never touches app data itself.
router.get('/usage', requireAuth, requirePrimaryOrgAdmin(), async (req, res) => {
    const orgId = req.primaryOrgId;
    const [totals, apps] = await Promise.all([
        studioAppQuota.orgUsage(orgId),
        studioAppQuota.orgAppBreakdown(orgId),
    ]);
    res.json({
        totals,
        apps,
        limits: {
            maxDbBytes: DATA_LIMITS.MAX_DB_BYTES,
            maxRowsPerApp: DATA_LIMITS.MAX_ROWS_PER_APP,
            maxRowsPerTable: DATA_LIMITS.MAX_ROWS_PER_TABLE,
            maxAttachmentsPerApp: DATA_LIMITS.MAX_ATTACHMENTS_PER_APP,
            maxAttachmentBytes: DATA_LIMITS.MAX_ATTACHMENT_BYTES,
        },
    });
});

router.post('/', requireAuth, requireManageApps, validate({ body: CreateAppBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { name, description, icon, accentColor, templateId } = req.body || {};
    const cleanName = (typeof name === 'string' && name.trim())
        ? name.trim().slice(0, LIMITS.MAX_NAME_LEN)
        : '';

    let definition;
    let template = null;
    if (templateId !== undefined && templateId !== null && templateId !== '') {
        const { orgIdArr } = await audienceFor(req);
        template = await resolveTemplate(templateId, { userId, orgIds: orgIdArr });
        if (!template) return res.status(404).json({ error: 'Template not found' });
        // Deep-clone so the shared TEMPLATES constant can never be mutated,
        // then canonicalize (fills defaults, re-keys any duplicate ids).
        const copy = JSON.parse(JSON.stringify(template.definition));
        if (cleanName) copy.meta = { ...(copy.meta || {}), name: cleanName };
        definition = canonicalizeAppDefinition(copy).def;
    } else {
        definition = emptyDefinition(cleanName || 'Untitled app');
    }

    const organizationId = await resolveOwnerOrgId(userId);
    const app = await studioAppStore.createStudioApp({
        userId,
        organizationId,
        name: cleanName || (template ? template.title : definition.meta?.name) || 'Untitled app',
        description: typeof description === 'string' ? description : (template ? template.description : ''),
        icon: (typeof icon === 'string' && icon) ? icon : (definition.meta?.icon || null),
        accentColor: (typeof accentColor === 'string' && accentColor) ? accentColor : null,
        definition,
        // Template provenance: version + a hash of the EXACT canonicalized
        // definition being saved. Hash equality with the current draft is
        // later what makes the app eligible for a one-click template
        // upgrade (templateUpgrade.js) — a blank app carries no stamp.
        ...(template ? {
            templateId: template.id,
            templateVersion: templateVersion(template),
            templateInstallHash: hashDefinition(definition),
        } : {}),
    });

    // Data-backed templates additionally install a data model + seed rows +
    // datasets via the single instantiation path (templateInstall.js). This
    // stays BEST-EFFORT — the app exists with a usable definition and data
    // can be added later, so a failure must not 500 a successful create —
    // but it is NO LONGER SILENT.
    //
    // Silence was its own bug: a data-backed template whose install failed
    // produced an app with every screen and NO tables and NO connector,
    // which reads as "the template forgot them". The only trace was a
    // server-side console.warn nobody was watching. The caller now learns
    // what happened and can say so.
    let dataInstall = null;
    if (template && (template.dataModel || template.seed || template.datasets)) {
        try {
            const install = await installTemplate({ appId: app.id, ownerId: userId, template });
            if (!install || !install.ok) {
                const reason = (install && install.error) || 'unknown error';
                log.warn(`[StudioApps] Template data install failed for ${app.id}: ${reason}`);
                dataInstall = { ok: false, error: reason };
            } else {
                dataInstall = { ok: true, dataModelVersion: install.dataModelVersion };
            }
        } catch (e) {
            const reason = e && e.message ? e.message : String(e);
            log.warn(`[StudioApps] Template data install threw for ${app.id}: ${reason}`);
            dataInstall = { ok: false, error: reason };
        }
    }

    res.json({ success: true, app: sanitizeAppRow(app), ...(dataInstall ? { dataInstall } : {}) });
});

router.get('/:id', requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app) return res.status(404).json({ error: 'App not found' });

    if (app.userId === userId) {
        return res.json({ app: sanitizeAppRow(app), readOnly: false, managed: await managedOf(app) });
    }

    const { orgIdArr, userGroups } = await audienceFor(req);
    if (!await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr)) {
        return refuseRead(res, app, orgIdArr);
    }
    // Non-owner reader: meta + the frozen published copy only — never the
    // owner's working draft.
    const { definition, ...meta } = sanitizeAppRow(app);
    res.json({ app: meta, readOnly: true, managed: await managedOf(app) });
});

/**
 * Resolve a back-pointer — "which button, in which screen, of this app".
 *
 * An automation made from a button in App Studio stores `trigger.appRef`
 * ({ appId, screenId, nodeId }); the builder's breadcrumb and the trigger card
 * both need to turn those three ids into words. The answer depends on WHO is
 * asking and on whether the app still has that screen, so neither the automation
 * nor the URL can carry it — see appStudio/appRefLookup.js for the three
 * outcomes and why a non-owner is told nothing but the ids.
 *
 * Always 200 for a signed-in caller: "the app is gone" and "you may not see
 * it" are ANSWERS this screen renders, not failures, and folding them into a
 * 404 would leave the card unable to tell them apart.
 */
router.get('/:id/ref', requireAuth, validate({ query: RefQuery }), async (req, res) => {
    const viewerUserId = req.session.user.id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    const ref = {
        appId: req.params.id,
        screenId: typeof req.query.screenId === 'string' ? req.query.screenId : null,
        nodeId: typeof req.query.nodeId === 'string' ? req.query.nodeId : null,
    };
    res.json(describeAppRef({ app: app || null, ref, viewerUserId }));
});

router.put('/:id', requireAuth, requireManageApps, validate({ body: UpdateAppBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { name, description, icon, accentColor, category } = req.body || {};

    const updates = {};
    if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'name must be a non-empty string' });
        }
        updates.name = name.trim().slice(0, LIMITS.MAX_NAME_LEN);
    }
    if (description !== undefined) {
        if (description !== null && typeof description !== 'string') {
            return res.status(400).json({ error: 'description must be a string' });
        }
        updates.description = description || '';
    }
    if (icon !== undefined) updates.icon = (typeof icon === 'string' && icon) ? icon : null;
    if (accentColor !== undefined) updates.accentColor = (typeof accentColor === 'string' && accentColor) ? accentColor : null;
    // Directory category. The vocabulary is the organisation's closed list,
    // which does not live here yet, so the route does the only two things
    // it can honestly do: trim, and cap. null/'' clears it — "uncategorised"
    // has to stay reachable, or an app can never leave a pill it landed in.
    if (category !== undefined) {
        if (category !== null && typeof category !== 'string') {
            return res.status(400).json({ error: 'category must be a string or null' });
        }
        updates.category = (typeof category === 'string' && category.trim())
            ? category.trim().slice(0, MAX_CATEGORY_LEN)
            : null;
    }
    if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
    }

    // updateStudioApp is owner-scoped in its WHERE — a non-owner gets null.
    const app = await studioAppStore.updateStudioApp(req.params.id, updates, userId);
    if (!app) return res.status(404).json({ error: 'App not found' });
    // The Nextcloud menu shows the name and icon; a change to either is a
    // change the connector has to see. Nobody is waiting on it here.
    if ((updates.name !== undefined || updates.icon !== undefined)
        && app.nextcloudMenu && app.isPublished && app.organizationId) {
        nextcloudMenuSync.notifyMenuChange(app.organizationId, { reason: 'update', appId: app.id });
    }
    res.json({ success: true, app: sanitizeAppRow(app) });
});

// Owner-only CAS save of the working definition.
router.put('/:id/definition', requireAuth, requireManageApps, validate({ body: DefinitionBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { definition, baseVersion } = req.body || {};
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
        return res.status(400).json({ error: 'definition (object) is required' });
    }
    if (!Number.isInteger(baseVersion)) {
        return res.status(400).json({ error: 'baseVersion (integer) is required' });
    }

    // Cheap byte ceiling BEFORE the O(n) canonicalize rebuild. The router
    // inherits the global 20MB json parser, so without this an owner could
    // spend a full canonicalize+validate pass on a multi-MB blob that
    // saveDefinition's 512KB cap would only reject afterwards. Measure the
    // raw definition; validate.js still enforces the exact serialized cap.
    const rawBytes = Buffer.byteLength(JSON.stringify(definition));
    if (rawBytes > LIMITS.MAX_DEFINITION_BYTES) {
        return res.status(413).json({ error: `App definition exceeds ${LIMITS.MAX_DEFINITION_BYTES} bytes` });
    }

    const { def: canonical, repairs } = canonicalizeAppDefinition(definition);
    // Data-reference cross-checks run demoted to WARNINGS on human saves:
    // a half-wired draft (binding to a table you'll create next) must stay
    // saveable — publish is where data references become hard errors.
    // Best-effort: a data-store hiccup skips the checks, never blocks a save.
    let dataRefs = {};
    try { dataRefs = await loadDataRefs(req.params.id, userId); } catch (_) { /* checks skipped */ }
    const { ok, errors, warnings } = validateAppDefinition(canonical, { ...dataRefs, dataRefsAsWarnings: true });
    if (!ok) return res.status(422).json({ error: 'App definition failed validation', errors, warnings });

    let result;
    try {
        result = await studioAppStore.saveDefinition(req.params.id, userId, canonical, { expectedVersion: baseVersion });
    } catch (e) {
        if (e.code === 'definition_too_large') {
            return res.status(413).json({ error: `App definition exceeds ${LIMITS.MAX_DEFINITION_BYTES} bytes` });
        }
        throw e;
    }
    if (result.notFound) return res.status(404).json({ error: 'App not found' });
    if (result.conflict) {
        // Hand the server's copy back so the editor can reconcile.
        return res.status(409).json({
            error: 'The app changed since you loaded it',
            conflict: true,
            currentVersion: result.currentVersion,
            definition: result.definition,
        });
    }
    res.json({ success: true, version: result.version, warnings, repairs });
});

router.delete('/:id', requireAuth, requireManageApps, async (req, res) => {
    const userId = req.session.user.id;
    // deleteStudioApp is owner-scoped — non-owners get null (404, no leak).
    const deleted = await studioAppStore.deleteStudioApp(req.params.id, userId);
    if (!deleted) return res.status(404).json({ error: 'App not found' });
    // A deleted app leaves the connector's desired list; its icon goes
    // with it on the very next sync rather than the next poll.
    if (deleted.nextcloudMenu && deleted.isPublished && deleted.organizationId) {
        nextcloudMenuSync.notifyMenuChange(deleted.organizationId, { reason: 'delete', appId: req.params.id });
    }
    res.json({ success: true });
});

module.exports = router;

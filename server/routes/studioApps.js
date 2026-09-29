/**
 * Studio App Routes — CRUD, publish, versions and runtime-read for App Studio.
 *
 * Apps are structured JSON component trees (never code); the schema is owned
 * by ../appStudio/componentSpecs.js. Every write runs through canonicalize →
 * validate before it reaches the store, and publish additionally re-checks
 * the CURRENT stored draft (including routine ownership) so a broken app can
 * never be frozen into published_definition.
 *
 * Endpoints (mounted at /api/studio-apps behind requireCapability('app_studio')):
 *   GET    /catalog                        — component/theme/action catalog (static)
 *   GET    /templates                      — template gallery (meta only)
 *   GET    /templates/:templateId          — one template incl. definition
 *   GET    /templates/:templateId/export   — one template as a portable file
 *   POST   /templates/import               — a template file → this org's gallery
 *   GET    /                               — apps visible to the caller (meta only)
 *   GET    /mine                           — apps the caller owns (meta only)
 *   POST   /                               — create app (blank or from template)
 *   GET    /:id                            — owner: full row; reader: meta + published_definition
 *   PUT    /:id                            — owner-only metadata update
 *   PUT    /:id/definition                 — owner-only CAS save (canonicalize + validate)
 *   PATCH  /:id/publish                    — owner-only publish/unpublish (freezes the draft)
 *   POST   /:id/template-upgrade           — owner-only upgrade of a PRISTINE app to the
 *                                            registry template's newer version (409 otherwise)
 *   PATCH  /:id/nextcloud-menu             — owner-only Nextcloud app-menu toggle
 *   DELETE /:id                            — owner-only delete
 *   GET    /:id/versions                   — owner-only publish-snapshot history
 *   POST   /:id/versions/:versionId/restore — owner-only restore snapshot → working draft
 *   GET    /:id/runtime                    — run-view payload (draft for owner, else published)
 *                                            + viewer { id, name, email, isOwner, roleKey }
 *
 * Visibility follows the webpages convention: anything the caller may not see
 * is a 404 (never leak existence); owner-only mutations on a *readable* app
 * are a 403.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();
const { validate } = require('../core/http/validate');
const { z, worded, bodyOf, queryOf, choice, wholeNumber } = require('../core/http/schemaParts');

// ── What the app-management routes accept ────────────────────────────
// Closed bodies and queries. What they close: `isPublished: "false"` on
// PATCH /:id/publish PUBLISHED the app (`!!"false"`), and a single group sent
// as text (`sharedGroups: "g1"`) became an org-wide publish on the first
// publish; `enabled: "false"` put the app IN the Nextcloud menu; `?draft=yes`
// served the published copy to an owner who asked for the draft. The two
// import routes stay open: their body may be the exported file itself, which
// sanitizeImport/sanitizeAppImport read field by field.
const appText = (message, max) => worded(message).max(max, message);
const nullableText = (name, max) => appText(`${name} is text of at most ${max} characters.`, max).nullish();
const CreateAppBody = bodyOf({
    name: nullableText('name', 500),
    description: nullableText('description', 10_000),
    icon: nullableText('icon', 200),
    accentColor: nullableText('accentColor', 64),
    templateId: nullableText('templateId', 200),
}, 'Creating an app');
const UpdateAppBody = bodyOf({
    name: appText('name must be a non-empty string', 500).optional(),
    description: nullableText('description', 10_000),
    icon: nullableText('icon', 200),
    accentColor: nullableText('accentColor', 64),
    // Capped to a pill's 64 characters by the handler, as before.
    category: worded('category must be a string or null').nullish(),
}, 'Updating an app');
const DefinitionBody = bodyOf({
    definition: z.record(z.unknown(), { required_error: 'definition (object) is required', invalid_type_error: 'definition (object) is required' }),
    baseVersion: wholeNumber('baseVersion is the version the editor loaded.'),
}, 'Saving the draft');
const GROUPS_TEXT = 'sharedGroups is a list of group ids; an empty list means the whole organisation.';
const PublishBody = bodyOf({
    isPublished: z.boolean({ required_error: 'isPublished is true or false.', invalid_type_error: 'isPublished is true or false.' }),
    sharedGroups: z.array(appText(GROUPS_TEXT, 200), { invalid_type_error: GROUPS_TEXT }).optional(),
}, 'Publishing an app');
const NextcloudMenuBody = bodyOf({
    enabled: z.boolean({ required_error: 'enabled is true or false.', invalid_type_error: 'enabled is true or false.' }),
}, 'The Nextcloud menu');
const CheckBody = bodyOf({
    screenId: nullableText('screenId', 200),
    asRole: nullableText('asRole', 100),
}, 'Checking an app');
const DownloadQuery = queryOf({ download: choice(['0', '1'], 'download is 1 to get the file.').optional() }, 'A template export');
const RefQuery = queryOf({
    screenId: appText('screenId is the id of a screen.', 200).optional(),
    nodeId: appText('nodeId is the id of a component.', 200).optional(),
}, 'An app reference');
const DraftQuery = queryOf({ draft: choice(['0', '1'], 'draft is 1 for the saved draft.').optional() }, 'The app runtime');

const studioAppStore = require('../stores/studioAppStore');
const studioAppDataStore = require('../stores/studioAppDataStore');
const automationStore = require('../stores/automationStore');
const userStore = require('../stores/userStore');
const rlsGateway = require('../appStudio/rlsGateway');
const { validateSharedGroupsForOrg } = require('../auth');
const { resolveAudienceContext } = require('../auth/audience');
const { buildCatalog, emptyDefinition, LIMITS } = require('../appStudio/componentSpecs');
const { canonicalizeAppDefinition } = require('../appStudio/canonicalize');
const { describeAppRef } = require('../appStudio/appRefLookup');
const { validateAppDefinition } = require('../appStudio/validate');
const { templateVersion } = require('../appStudio/templates');
const { listAvailableTemplates, resolveTemplate, templateResolverFor } = require('../appStudio/templateRegistry');
const studioAppTemplateStore = require('../stores/studioAppTemplateStore');
const { installTemplate } = require('../appStudio/templateInstall');
const { buildExport, sanitizeImport, exportFilename } = require('../appStudio/templatePortability');
const { sanitizeAppImport } = require('../appStudio/appPortability');
const { installAppContent } = require('../appStudio/appContentInstall');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { hashDefinition, isPristine, upgradeCandidate, annotateTemplateUpgrades } = require('../appStudio/templateUpgrade');
const studioAppQuota = require('../appStudio/studioAppQuota');
const { DATA_LIMITS } = require('../appStudio/dataModel');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
// requirePrimaryOrgAdmin gates org-scoped read views on the CALLER's own org
// (org admin or super admin) and attaches req.primaryOrgId for the handler.
const { requireAuth, requirePrimaryOrgAdmin, requirePermission } = require('../auth/permissions');

// ── Who may BUILD an app, as opposed to use one ──────────────────────
// The mount in server/index.js gates /api/studio-apps on requireModule('apps')
// + requireCapability('app_studio'). Those answer "does this installation have
// App Studio?" — not "may this person build and publish with it". The
// `manage_apps` permission existed in the registry and had no enforcement site
// anywhere, so any signed-in member of an org with the capability could create
// an app and publish it to the whole organisation, or mint a public internet
// URL for it.
//
// It bites hardest on self-hosted, where beta capabilities are granted
// org-wide to every member (core/entitlements/entitlements.js), so narrowing by
// group does not help there.
//
// WHO HOLDS IT — config/orgRoles.json. The gate went in (2026-09-09) on the
// belief that the role policy already handed the permission out; it did not,
// no org role carried it, so until 2026-09-12 only a platform super-admin could
// create, save or publish an app, and an org admin arriving through the
// Nextcloud connector got "Permission 'manage_apps' required" on a blank
// New-app form. Building an app is authoring, so the three authoring roles
// (org_admin, agent_admin, agent_editor — the ones that hold manage_agents)
// carry it and a plain member does not. routes/writeGates.test.js pins both
// halves: the gate on the routes AND a grant in the policy.
//
// Applied to the WRITE and PUBLISH routes only. Reading and running an app stay
// on the capability: using what somebody else built is the ordinary case, and
// the runtime routes have their own per-app access rules.
const requireManageApps = requirePermission('manage_apps');

const publicAccess = require('../appStudio/publicAccess');
// Who can reach an app is an access-control fact, so a change to it is an
// audit event — see appStudio/publicationAudit.js.
const publicationAudit = require('../appStudio/publicationAudit');
// "Show in the Nextcloud app menu" is served by the org's connector; these
// routes tell it to sync the moment the desired list changes, instead of
// leaving the owner to wait for its poll — see appStudio/nextcloudMenuSync.js.
const nextcloudMenuSync = require('../appStudio/nextcloudMenuSync');
const { publicAppUrlForToken } = require('../automation/publicUrl');

// One app, one live public URL by default. Rotating one means revoking the old
// explicitly, so a link already sent to customers never dies by accident.
const MAX_PUBLIC_PAGES_PER_APP = 3;

// resolveUserOrgIds returns null for super-admin; collapse Sets/null to a
// plain array so the store predicates can iterate it (same as webpages.js).
async function audienceFor(req) {
    const { userId, orgIds, userGroups } = await resolveAudienceContext(req);
    const orgIdArr = orgIds instanceof Set ? [...orgIds] : (Array.isArray(orgIds) ? orgIds : []);
    return { userId, orgIdArr, userGroups };
}

/**
 * The refusal for a read the audience check turned down.
 *
 * A stranger gets the uniform 404 — an app must not confirm its existence to
 * someone outside its organisation. A member of the app's own organisation who
 * is simply not in the groups it was published to gets a 403 that says so:
 * they are the intended reader pool, they reached the app by an id that is
 * 122 random bits (nothing to enumerate), and once the app sits in the org's
 * Nextcloud menu its name is in front of them anyway. What they see instead of
 * "not found" is "shared with specific groups — ask the owner", which is the
 * truth and the one thing they can act on. The body carries no name and no
 * owner; a published-to-groups app reveals nothing more than that it exists.
 */
function refuseRead(res, app, orgIdArr) {
    if (app.isPublished && app.organizationId && orgIdArr.includes(app.organizationId)) {
        return res.status(403).json({
            error: 'This app is shared with specific groups in your organisation',
            code: 'not_in_audience',
        });
    }
    return res.status(404).json({ error: 'App not found' });
}

// Owner's org: primary organizationId first, then the org of their first
// org-bearing group — mirrors the entire-org publish fallback in webpages.js.
async function resolveOwnerOrgId(userId) {
    const owner = await userStore.getUser(userId);
    let organizationId = owner?.organizationId || null;
    if (!organizationId) {
        const groups = Array.isArray(owner?.groups) ? owner.groups
            : (() => { try { return JSON.parse(owner?.groups || '[]'); } catch { return []; } })();
        if (groups.length > 0) {
            const allGroups = await userStore.getAllGroups();
            const g = allGroups.find(x => groups.includes(x.id) && x.organizationId);
            organizationId = g?.organizationId || null;
        }
    }
    return organizationId;
}

// Ceiling on the directory category (APPS-04). Not a validation of the value —
// the org's closed list is what decides that, and it does not live here yet —
// only a ceiling, so a pasted paragraph can never become a filter pill.
const MAX_CATEGORY_LEN = 64;

// The store never puts builder_session on app rows, but strip it anyway so a
// future store change can't silently start leaking the AI chat snapshot.
function sanitizeAppRow(app) {
    if (!app || typeof app !== 'object') return app;
    const { builderSession, builder_session, ...rest } = app;
    return rest;
}

// Owner's routines in the shape validate.js expects for opts.ownedAutomations.
async function loadOwnedAutomations(ownerId) {
    const owned = await automationStore.getAutomationsForUser(ownerId);
    return (owned || []).map(a => ({ id: a.id, userId: a.userId, isActive: a.isActive }));
}

// The app's data model + dataset ids in the shape validate.js expects for
// opts.dataModel/opts.datasets (data-reference cross-checks). `model` is null
// when the app has no data model yet — validate treats every table reference
// as unknown then, which is exactly right.
//
// `datatables` is de derde: zonder die lijst was `binding.unknown_datatable`
// onbereikbaar (geen enkele aanroeper vulde opts.datatables) en kreeg élke
// binding op een gekoppelde tabel bij élke save de waarschuwing
// `binding.datatable_unverified` die de auteur nooit kon wegwerken — terwijl
// een app met een datatableId die nergens naar wijst schoon publiceerde en pas
// bij de eerste lezing brak.
async function loadDataRefs(appId, ownerId) {
    const meta = await studioAppDataStore.getDataModel(appId, ownerId);
    const datasets = await studioAppDataStore.listDatasets(appId, ownerId);
    return {
        dataModel: (meta && meta.model) ? meta.model : null,
        datasets: (datasets || []).map(d => d.id),
        datatables: await require('../appStudio/datatableSource').listOwnerDatatableIds(ownerId),
    };
}

// ── Catalog & templates (static — before any /:id route) ───────────

router.get('/catalog', requireAuth, (req, res) => {
    res.set('Cache-Control', 'private, max-age=3600');
    res.json(buildCatalog());
});

// The gallery is BOTH halves at once: the built-in starters plus whatever this
// organisation captured from its own apps (app_save_as_template). See
// appStudio/templateRegistry.js — a captured template installs by exactly the
// same path, so nothing below this line needs to know which kind it got.
router.get('/templates', requireAuth, async (req, res) => {
    try {
        const { userId, orgIdArr } = await audienceFor(req);
        res.json({ templates: await listAvailableTemplates({ userId, orgIds: orgIdArr }) });
    } catch (err) {
        log.error('[StudioApps] Template list failed:', err);
        res.status(500).json({ error: 'Failed to list templates' });
    }
});

router.get('/templates/:templateId', requireAuth, async (req, res) => {
    try {
        const { userId, orgIdArr } = await audienceFor(req);
        const template = await resolveTemplate(req.params.templateId, { userId, orgIds: orgIdArr });
        if (!template) return res.status(404).json({ error: 'Template not found' });
        res.json({ template });
    } catch (err) {
        log.error('[StudioApps] Template read failed:', err);
        res.status(500).json({ error: 'Failed to read template' });
    }
});

// Deleting a CAPTURED template — the creator, or an admin of the org it was
// shared with. Built-in templates are code and have no delete: a 404 for a
// non-utpl_ id is the honest answer rather than a 403 implying it might work
// with more rights.
router.delete('/templates/:templateId', requireAuth, requireManageApps, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { orgIdArr } = await audienceFor(req);
        const templateId = req.params.templateId;
        if (!studioAppTemplateStore.isCapturedTemplateId(templateId)) {
            return res.status(404).json({ error: 'Template not found' });
        }
        const existing = await studioAppTemplateStore.getTemplateById(templateId);
        if (!existing) return res.status(404).json({ error: 'Template not found' });

        // An org admin may clear out a template a departed colleague left in
        // the org's gallery; the store's own rule is creator-only.
        const isOrgAdmin = !!req.session.user.isSuperAdmin
            || (req.session.user.isOrgAdmin && existing.organizationId
                && orgIdArr.includes(existing.organizationId));
        const out = await studioAppTemplateStore.deleteTemplate(templateId, userId, { force: isOrgAdmin });
        if (out.notFound) return res.status(404).json({ error: 'Template not found' });
        if (out.forbidden) return res.status(403).json({ error: 'Only the template\'s creator can delete it' });
        res.json({ success: true });
    } catch (err) {
        log.error('[StudioApps] Template delete failed:', err);
        res.status(500).json({ error: 'Failed to delete template' });
    }
});

/**
 * GET /templates/:templateId/export — the template as a portable FILE.
 *
 * Reading a template you may install is what this is; it produces the same
 * substance `GET /templates/:templateId` already hands the editor, written in
 * the interchange format and scrubbed once more on the way out
 * (appStudio/templatePortability.js). So the gate is the same visibility check
 * the read route uses — a template you cannot see 404s — plus `manage_apps`,
 * because shipping a template to another installation is authoring, not using.
 *
 * `download=1` sets Content-Disposition so a browser saves it under the
 * template's own name, and answers with the envelope ALONE — what the scrub
 * cleared is news for the person exporting, and a note folded into the file
 * would travel to the recipient as though it were part of the template. The
 * default JSON shape is the one that carries the warnings, which is why the
 * editor uses it and saves the file itself.
 */
router.get('/templates/:templateId/export', requireAuth, requireManageApps, validate({ query: DownloadQuery }),
    require('../compliance/dataPortability/stampExport')('app_templates'),
    async (req, res) => {
        try {
            const { userId, orgIdArr } = await audienceFor(req);
            const template = await resolveTemplate(req.params.templateId, { userId, orgIds: orgIdArr });
            if (!template) return res.status(404).json({ error: 'Template not found' });

            // The organisation NAME is read here rather than in buildExport for
            // the reason manifest.withSource gives: a capture knows the thing it
            // captured, not the tenant it sat in, and the name is a courtesy to
            // the recipient ("this came from Acme") rather than anything the
            // format depends on.
            let orgName = null;
            // resolveOwnerOrgId, not `session.user.organizationId`: it is the
            // same answer for most people and the right one for a member whose
            // organisation comes from a group rather than the user row — and it
            // is what the import route on the other side uses to decide where a
            // template lands, so the two halves agree on what "your
            // organisation" means.
            const orgId = await resolveOwnerOrgId(userId);
            if (orgId) {
                try {
                    const org = await userStore.getOrganization(orgId);
                    orgName = (org && typeof org.name === 'string') ? org.name : null;
                } catch { /* a missing name is a missing courtesy, not a failed export */ }
            }

            const { envelope, warnings } = buildExport(template, {
                exportedAt: new Date().toISOString(),
                source: { templateId: template.id, orgId, orgName, version: templateVersion(template) },
            });
            if (!envelope) return res.status(500).json({ error: 'Failed to export template' });

            if (req.query.download === '1') {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(template)}"`);
                return res.send(JSON.stringify(envelope, null, 2));
            }
            res.json({ envelope, warnings, filename: exportFilename(template) });
        } catch (err) {
            log.error('[StudioApps] Template export failed:', err);
            res.status(500).json({ error: 'Failed to export template' });
        }
    });

/**
 * POST /templates/import — take a template file into this organisation's
 * gallery, as a captured template like any other.
 *
 * Registered BEFORE `/templates/:templateId` would be reached by a POST, and
 * kept next to it so the literal "import" is never read as a template id — the
 * same route-order rule routes/automation/crud.js documents for its own import.
 *
 * WHAT THIS ROUTE DOES NOT DO is create an app. The file lands in the gallery
 * and the existing create-from-template path turns it into one, which means an
 * imported template installs through `studioApps.js` + `templateInstall.js`
 * exactly as a built-in does: one installer, three ways for a template to be
 * born. It also means importing once and creating five apps is the ordinary
 * case rather than five imports.
 *
 * The body is either a bare envelope or `{ envelope }` — a file read straight
 * off disk by a client is the first shape and a hand-written call tends to be
 * the second, and rejecting one of them would be a riddle rather than a rule.
 *
 * Rate-limited per user: an import validates a whole definition and writes a
 * multi-megabyte JSONB row, so 10/min is generous for a person and useless for
 * a script filling the org's hundred-template ceiling.
 */
const templateImportLimiter = perUserRateLimit({ windowMs: 60_000, max: 10 });
router.post('/templates/import', requireAuth, requireManageApps, templateImportLimiter, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const body = req.body || {};
        const envelope = (body && typeof body === 'object' && body.envelope !== undefined) ? body.envelope : body;

        const { template, report, errors, warnings } = sanitizeImport(envelope);
        if (!template) {
            return res.status(400).json({ error: 'That file could not be imported', code: 'invalid_template', details: errors });
        }

        // A name the importer chose wins over the one in the file: two copies of
        // the same template in one gallery is the common reason to import twice,
        // and a gallery of identical titles is not a gallery.
        const chosen = (typeof body.title === 'string' && body.title.trim())
            ? body.title.trim().slice(0, 80) : null;
        if (chosen) {
            template.title = chosen;
            if (template.definition && typeof template.definition === 'object') {
                template.definition.meta = { ...(template.definition.meta || {}), name: chosen };
            }
        }

        // The org of the importer, resolved the same way a capture resolves it,
        // so an imported template is visible to the colleagues who will install
        // it. A user with no organisation keeps it to themselves — the store's
        // own rule, not a special case here.
        const organizationId = await resolveOwnerOrgId(userId);

        const { definition, dataModel, seed, seedPeople, datasets } = template;
        const saved = await studioAppTemplateStore.saveTemplate({
            organizationId,
            createdBy: userId,
            // Imported, not captured: there is no app here it came from, and
            // writing one in would claim a provenance this installation cannot
            // vouch for.
            sourceAppId: null,
            title: template.title,
            description: template.description,
            category: template.category,
            icon: template.icon,
            tags: template.tags,
            payload: {
                definition,
                ...(dataModel ? { dataModel } : {}),
                ...(seed ? { seed } : {}),
                ...(seedPeople ? { seedPeople } : {}),
                ...(datasets ? { datasets } : {}),
            },
        });

        res.status(201).json({ template: saved, report, warnings });
    } catch (err) {
        const message = err && err.message ? err.message : 'Failed to import template';
        // The two ceilings the store enforces are the user's to act on (delete
        // one, or capture fewer seed tables), not a server fault.
        if (/limit reached|exceeds/i.test(message)) {
            return res.status(409).json({ error: message, code: 'template_limit' });
        }
        log.error('[StudioApps] Template import failed:', err);
        res.status(500).json({ error: 'Failed to import template' });
    }
});

// ── App CRUD ────────────────────────────────────────────────────────

router.get('/', requireAuth, async (req, res) => {
    try {
        const { userId, orgIdArr, userGroups } = await audienceFor(req);
        const apps = await studioAppStore.getAccessibleStudioApps(userId, userGroups, orgIdArr);
        res.json({ apps: apps.map(sanitizeAppRow) });
    } catch (err) {
        log.error('[StudioApps] List failed:', err);
        res.status(500).json({ error: 'Failed to list apps' });
    }
});

router.get('/mine', requireAuth, async (req, res) => {
    try {
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
    } catch (err) {
        log.error('[StudioApps] List own failed:', err);
        res.status(500).json({ error: 'Failed to list apps' });
    }
});

// ── Org-admin storage usage view ────────────────────────────────────
// Org totals + a per-app storage breakdown for the caller's own org. Gated on
// org-admin (or super admin) via requirePrimaryOrgAdmin, which resolves and
// attaches req.primaryOrgId. Read-only aggregate over Postgres facts (each
// app's SQLite db_size + the attachment ledger); never touches app data itself.
router.get('/usage', requireAuth, requirePrimaryOrgAdmin(), async (req, res) => {
    try {
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
    } catch (err) {
        log.error('[StudioApps] Usage read failed:', err);
        res.status(500).json({ error: 'Failed to load usage' });
    }
});

router.post('/', requireAuth, requireManageApps, validate({ body: CreateAppBody }), async (req, res) => {
    try {
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
    } catch (err) {
        log.error('[StudioApps] Create failed:', err);
        res.status(500).json({ error: 'Failed to create app' });
    }
});

/**
 * POST /import — an app archive file → a live app in this organisation.
 *
 * Registered BEFORE the `/:id` routes so the literal "import" is never read as
 * an app id: the same route-order rule `/templates/import` follows above.
 *
 * THIS IS NOT THE TEMPLATE IMPORT, and the difference is the whole point of
 * having both. `/templates/import` puts a BLUEPRINT in the gallery, from which
 * anyone can create as many empty apps as they like. This takes a PARTICULAR
 * app — its rows, and the documents those rows are about — and stands it up
 * once, working. See appStudio/appPortability.js for why they are separate
 * formats with separate ceilings.
 *
 * There is no route that writes one of these files. An archive is built by a
 * script, by somebody with a shell on the server; the product can open one and
 * can never produce one, so no menu item turns a live app's customer data into
 * a file somebody can carry out of the building.
 *
 * ALL OR NOTHING, ON THE PART THAT MATTERS. `POST /` treats a failed data
 * install as best-effort, because an app with screens and no tables is still
 * an app somebody asked for. Here nobody asked for that: the archive IS the
 * data. So a data model that will not install takes the app row with it rather
 * than leaving a shell behind that reads as "the import forgot the tables".
 * Individual rows and files stay best-effort and are named in the report —
 * `appContentInstall.js` explains why that line is drawn where it is.
 *
 * Rate-limited hard: one call parses up to 20 MB, writes thousands of rows and
 * runs a malware scan per file. 3/min is unhurried for a person and useless as
 * a way to fill the disk.
 */
const appImportLimiter = perUserRateLimit({ windowMs: 60_000, max: 3 });
router.post('/import', requireAuth, requireManageApps, appImportLimiter, async (req, res) => {
    let created = null;
    try {
        const userId = req.session.user.id;
        const body = req.body || {};
        const envelope = (body && typeof body === 'object' && body.envelope !== undefined) ? body.envelope : body;

        const { app: appMeta, template, content, report, errors, warnings } = sanitizeAppImport(envelope);
        if (!template) {
            return res.status(400).json({ error: 'That file could not be imported', code: 'invalid_archive', details: errors });
        }

        // A name the importer chose wins over the one in the file — two copies
        // of the same demo is the common reason to import twice.
        const chosen = (typeof body.name === 'string' && body.name.trim())
            ? body.name.trim().slice(0, LIMITS.MAX_NAME_LEN) : null;
        const name = chosen || appMeta.name || template.title || 'Imported app';

        const copy = JSON.parse(JSON.stringify(template.definition));
        copy.meta = { ...(copy.meta || {}), name };
        const definition = canonicalizeAppDefinition(copy).def;

        // Owner and organisation are facts of THIS installation, read from the
        // session and never from the file.
        const organizationId = await resolveOwnerOrgId(userId);
        created = await studioAppStore.createStudioApp({
            userId,
            organizationId,
            name,
            description: appMeta.description || template.description || '',
            icon: appMeta.icon || definition.meta?.icon || null,
            accentColor: appMeta.accentColor || null,
            definition,
            // No template provenance stamp: an archive is not a template, so
            // there is nothing here that a one-click template upgrade could
            // ever be offered against.
        });

        const install = await installTemplate({ appId: created.id, ownerId: userId, template });
        if (!install || !install.ok) {
            const why = (install && install.error) || 'unknown error';
            await studioAppStore.deleteStudioApp(created.id, userId).catch(() => {});
            created = null;
            return res.status(422).json({ error: `The app's data model could not be installed: ${why}`, code: 'model_install_failed' });
        }

        const model = template.dataModel || null;
        const app = await studioAppStore.getStudioApp(created.id);
        const filled = await installAppContent({ app, model, content });
        if (!filled.ok) {
            // The rows stopped part-way (a quota, a ceiling). The app and what
            // did land stay — deleting it would throw away the half that works
            // and tell the importer nothing about why.
            log.warn(`[StudioApps] Archive content install incomplete for ${created.id}: ${filled.error}`);
        }

        res.status(201).json({
            success: true,
            app: sanitizeAppRow(app),
            report: {
                ...report,
                installed: { rows: filled.rows, files: filled.files, dataModelVersion: install.dataModelVersion },
            },
            warnings: [
                ...warnings,
                ...(filled.error ? [filled.error] : []),
                ...filled.skipped,
            ],
        });
    } catch (err) {
        // An app created before the failure is not left behind: a half-imported
        // app nobody asked for is worse than an import that plainly failed.
        if (created) {
            await studioAppStore.deleteStudioApp(created.id, req.session.user.id).catch(() => {});
        }
        const message = err && err.message ? err.message : 'Failed to import app';
        if (/limit reached|exceeds|quota/i.test(message)) {
            return res.status(409).json({ error: message, code: 'app_limit' });
        }
        log.error('[StudioApps] App import failed:', err);
        res.status(500).json({ error: 'Failed to import app' });
    }
});

router.get('/:id', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app) return res.status(404).json({ error: 'App not found' });

        if (app.userId === userId) {
            return res.json({ app: sanitizeAppRow(app), readOnly: false });
        }

        const { orgIdArr, userGroups } = await audienceFor(req);
        if (!await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr)) {
            return refuseRead(res, app, orgIdArr);
        }
        // Non-owner reader: meta + the frozen published copy only — never the
        // owner's working draft.
        const { definition, ...meta } = sanitizeAppRow(app);
        res.json({ app: meta, readOnly: true });
    } catch (err) {
        log.error('[StudioApps] Get failed:', err);
        res.status(500).json({ error: 'Failed to get app' });
    }
});

/**
 * Resolve a back-pointer — "which button, in which screen, of this app".
 *
 * A routine made from a button in App Studio stores `trigger.appRef`
 * ({ appId, screenId, nodeId }); the builder's breadcrumb and the trigger card
 * both need to turn those three ids into words. The answer depends on WHO is
 * asking and on whether the app still has that screen, so neither the routine
 * nor the URL can carry it — see appStudio/appRefLookup.js for the three
 * outcomes and why a non-owner is told nothing but the ids.
 *
 * Always 200 for a signed-in caller: "the app is gone" and "you may not see
 * it" are ANSWERS this screen renders, not failures, and folding them into a
 * 404 would leave the card unable to tell them apart.
 */
router.get('/:id/ref', requireAuth, validate({ query: RefQuery }), async (req, res) => {
    try {
        const viewerUserId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        const ref = {
            appId: req.params.id,
            screenId: typeof req.query.screenId === 'string' ? req.query.screenId : null,
            nodeId: typeof req.query.nodeId === 'string' ? req.query.nodeId : null,
        };
        res.json(describeAppRef({ app: app || null, ref, viewerUserId }));
    } catch (err) {
        log.error('[StudioApps] Ref lookup failed:', err);
        res.status(500).json({ error: 'Failed to resolve reference' });
    }
});

router.put('/:id', requireAuth, requireManageApps, validate({ body: UpdateAppBody }), async (req, res) => {
    try {
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
    } catch (err) {
        log.error('[StudioApps] Update failed:', err);
        res.status(500).json({ error: 'Failed to update app' });
    }
});

// Owner-only CAS save of the working definition.
router.put('/:id/definition', requireAuth, requireManageApps, validate({ body: DefinitionBody }), async (req, res) => {
    try {
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
    } catch (err) {
        log.error('[StudioApps] Save definition failed:', err);
        res.status(500).json({ error: 'Failed to save definition' });
    }
});

// ── Publish (org/group visibility; freezes the draft) ───────────────

router.patch('/:id/publish', requireAuth, requireManageApps, validate({ body: PublishBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app) return res.status(404).json({ error: 'App not found' });

        // Publish is owner-only (canWriteStudioApp) — app actions run routines
        // acts-as-author. Readers get a 403; everyone else the same 404 as GET.
        if (!studioAppStore.canWriteStudioApp(app, userId)) {
            const { orgIdArr, userGroups } = await audienceFor(req);
            if (studioAppStore.canReadStudioApp(app, userId, userGroups, orgIdArr)) {
                return res.status(403).json({ error: 'Only the owner can change publish state' });
            }
            return res.status(404).json({ error: 'App not found' });
        }

        const { isPublished, sharedGroups } = req.body || {};
        const publishing = !!isPublished;

        // The exact validated bytes to freeze — closes the publish TOCTOU by
        // handing the setter the validated def rather than letting it re-read a
        // column a concurrent save may have moved on.
        let validatedDef;
        if (publishing) {
            // Refuse to freeze a broken draft: canonicalize + validate the
            // CURRENT stored definition, including publish-time routine checks
            // against the owner's automations (dangling/foreign/inactive
            // automationIds block publish) AND data-reference checks against
            // the app's data model + datasets (a binding/step referencing a
            // nonexistent table/dataset/field blocks publish — hard errors
            // here, warnings on draft saves).
            const { def: canonical } = canonicalizeAppDefinition(app.definition);
            const ownedAutomations = await loadOwnedAutomations(app.userId);
            const dataRefs = await loadDataRefs(req.params.id, app.userId);
            const { ok, errors, warnings } = validateAppDefinition(canonical, { ownedAutomations, ...dataRefs });
            if (!ok) {
                return res.status(422).json({ error: 'Fix the app\'s validation errors before publishing', errors, warnings });
            }
            validatedDef = canonical;
        }

        // Stamp organization_id on first publish. Group-scoped publishes derive
        // the org from THOSE groups (owner can be in multiple orgs); entire-org
        // publishes fall back to the owner's org — mirrors webpages.js.
        let organizationId;
        if (publishing && !app.organizationId) {
            const incomingGroups = Array.isArray(sharedGroups)
                ? sharedGroups.map(g => String(g)).filter(Boolean)
                : [];
            if (incomingGroups.length > 0) {
                const allGroups = await userStore.getAllGroups();
                const byId = new Map(allGroups.map(g => [g.id, g]));
                const orgs = new Set();
                for (const gid of incomingGroups) {
                    const g = byId.get(gid);
                    if (!g) return res.status(400).json({ error: `Unknown group: ${gid}` });
                    if (g.organizationId) orgs.add(g.organizationId);
                }
                if (orgs.size === 0) {
                    return res.status(400).json({ error: 'Cannot publish: shared groups have no organisation' });
                }
                if (orgs.size > 1) {
                    return res.status(400).json({ error: 'Cannot publish to groups across multiple organisations' });
                }
                organizationId = [...orgs][0];
            } else {
                organizationId = await resolveOwnerOrgId(app.userId);
                if (!organizationId) {
                    return res.status(400).json({ error: 'Cannot publish: owner has no organisation' });
                }
            }
        }

        // Validate sharedGroups against the app's org (existing org sticks; a
        // new org applies on first publish). undefined → preserve DB value.
        const effectiveOrg = app.organizationId || organizationId || null;
        let cleanedGroups;
        try {
            cleanedGroups = await validateSharedGroupsForOrg(effectiveOrg, sharedGroups);
        } catch (e) {
            return res.status(e.status || 500).json({ error: e.message });
        }

        // app.definitionVersion is the version validatedDef was read at — it
        // travels with the def so published_version names the draft that
        // actually went live (see setStudioAppPublished).
        const ok = await studioAppStore.setStudioAppPublished(
            req.params.id, publishing, app.userId, cleanedGroups, organizationId, validatedDef,
            publishing ? app.definitionVersion : undefined
        );
        if (!ok) return res.status(500).json({ error: 'Failed to update published status' });
        // After the store write, so the trail never claims a publish that did
        // not take. Best-effort: it cannot fail the publish.
        await publicationAudit.auditPublishChange({
            app, actorId: userId, isPublished: publishing, sharedGroups: cleanedGroups,
            organizationId: effectiveOrg,
            publishedVersion: publishing ? app.definitionVersion : (app.publishedVersion ?? null),
        });
        // The connector lists only PUBLISHED apps with the menu flag, so a
        // publish or unpublish of a flagged app adds or removes its icon.
        // Fire-and-forget: the answer to a publish is the publish, and the
        // dialog's own menu toggle (below) is where the connector's verdict is
        // waited for and shown.
        if (app.nextcloudMenu && effectiveOrg) {
            nextcloudMenuSync.notifyMenuChange(effectiveOrg, { reason: publishing ? 'publish' : 'unpublish', appId: app.id });
        }
        res.json({
            success: true,
            isPublished: publishing,
            sharedGroups: cleanedGroups,
            // Unpublish leaves the frozen copy (and its version) untouched.
            publishedVersion: publishing ? app.definitionVersion : (app.publishedVersion ?? null),
        });
    } catch (err) {
        log.error('[StudioApps] Publish failed:', err);
        res.status(500).json({ error: 'Failed to update publish state' });
    }
});

/**
 * PATCH /:id/nextcloud-menu — owner-only toggle for the Nextcloud app menu.
 *
 * When enabled (and the app is org-published), the organisation's Nextcloud
 * connector registers a top-menu entry for this app on its next sync, so the
 * app opens on its own page inside Nextcloud. The flag survives unpublish —
 * the connector list (routes/nextcloudStudioApps.js) filters on is_published,
 * so the entry disappears with the publish state and returns with it.
 *
 * Body: { enabled: boolean }. Enabling requires a live published copy: a menu
 * entry pointing at an app every viewer 404s on is a broken icon, not a
 * feature.
 *
 * After the write, the org's connector is asked to sync NOW and the route
 * waits (briefly) for its verdict, so the response can carry
 *   `ncConnected` — does the org have a paired connector at all, and
 *   `ncSync`      — 'synced' when the connector confirmed the OCS rows exist,
 *                   else why not (see appStudio/nextcloudMenuSync.js),
 * and the dialog can say "reload Nextcloud to see it" only when that is true,
 * and "within a few minutes" (the poll backstop) when it is not.
 */
router.patch('/:id/nextcloud-menu', requireAuth, requireManageApps, validate({ body: NextcloudMenuBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app) return res.status(404).json({ error: 'App not found' });

        // Same gate shape as publish: owner-only; readers 403, strangers 404.
        if (!studioAppStore.canWriteStudioApp(app, userId)) {
            const { orgIdArr, userGroups } = await audienceFor(req);
            if (studioAppStore.canReadStudioApp(app, userId, userGroups, orgIdArr)) {
                return res.status(403).json({ error: 'Only the owner can change the Nextcloud menu setting' });
            }
            return res.status(404).json({ error: 'App not found' });
        }

        const enabled = !!(req.body && req.body.enabled);
        if (enabled && (!app.isPublished || !app.publishedDefinition)) {
            return res.status(409).json({
                error: 'Publish the app first — the Nextcloud menu can only show published apps',
                code: 'not_published',
            });
        }

        const updated = await studioAppStore.setStudioAppNextcloudMenu(req.params.id, app.userId, enabled);
        if (!updated) return res.status(500).json({ error: 'Failed to update Nextcloud menu setting' });
        // Not an access change on its own — the app is already org-published to
        // get here — but it puts the app in front of everyone in the
        // organisation, so it belongs on the same trail.
        await publicationAudit.auditNextcloudMenu({ app, actorId: req.session.user.id, enabled });

        // Never throws; a connector that is down or absent is an outcome, not
        // an error — the toggle itself has already been saved.
        const sync = app.organizationId
            ? await nextcloudMenuSync.requestMenuSync(app.organizationId, { reason: 'nextcloud_menu', appId: app.id })
            : { outcome: 'not_connected' };

        res.json({
            success: true,
            nextcloudMenu: updated.nextcloudMenu,
            ncConnected: sync.outcome !== 'not_connected',
            ncSync: sync.outcome,
        });
    } catch (err) {
        log.error('[StudioApps] Nextcloud menu toggle failed:', err);
        res.status(500).json({ error: 'Failed to update Nextcloud menu setting' });
    }
});

// ── Public pages (anonymous entry points) ───────────────────────────
//
// A public page is a URL that opens the screens named in the app definition's
// `publicAccess` block to anyone, with no session — see appStudio/
// publicAccess.js and routes/studioAppPublic.js. Owner-only, all three: minting
// one is publishing part of an app to the open internet.
//
//   GET    /:id/public-pages           → { pages: [{ token, url, visits, … }], publicAccess }
//   POST   /:id/public-pages           → mint one
//   DELETE /:id/public-pages/:token    → revoke one

/** Owner-only gate: a readable non-owner gets 403, a stranger the uniform 404. */
async function loadOwnedAppForPublic(req, res) {
    const userId = req.session.user.id;
    const app = await studioAppStore.getStudioApp(req.params.id);
    if (!app) { res.status(404).json({ error: 'App not found' }); return null; }
    if (!studioAppStore.canWriteStudioApp(app, userId)) {
        const { orgIdArr, userGroups } = await audienceFor(req);
        if (studioAppStore.canReadStudioApp(app, userId, userGroups, orgIdArr)) {
            res.status(403).json({ error: 'Only the owner can manage public pages' });
            return null;
        }
        res.status(404).json({ error: 'App not found' });
        return null;
    }
    return app;
}

/**
 * Why a page can be minted but not yet live. Surfaced to the owner as a
 * `blockers` array so the UI can say what to fix — the anonymous route itself
 * answers a uniform 404 and explains nothing, which is right for a visitor and
 * useless for the person who built the app.
 */
function publicPageBlockers(app) {
    const blockers = [];
    const draft = app.definition && typeof app.definition === 'object' ? app.definition : null;
    const published = app.publishedDefinition && typeof app.publishedDefinition === 'object' ? app.publishedDefinition : null;

    if (!draft || !draft.publicAccess) {
        blockers.push({ code: 'no_public_access', message: 'The app has no publicAccess block — name the screen an anonymous visitor may open.' });
    }
    if (!app.isPublished || !published) {
        blockers.push({ code: 'not_published', message: 'Publish the app: anonymous visitors are always served the frozen published definition.' });
    } else if (!published.publicAccess) {
        blockers.push({ code: 'not_in_published', message: 'The published copy has no publicAccess block — publish again so the change goes live.' });
    } else if (!publicAccess.resolvePublicSurface(published).ok) {
        blockers.push({ code: 'surface_unresolved', message: 'The published publicAccess block does not resolve to a screen — check entryScreenId.' });
    }
    return blockers;
}

function publicPageView(page, req) {
    return {
        token: page.token,
        url: publicAppUrlForToken(page.token, req),
        createdAt: page.createdAt,
        lastSeenAt: page.lastSeenAt,
        visits: page.visits,
    };
}

router.get('/:id/public-pages', requireAuth, async (req, res) => {
    try {
        const app = await loadOwnedAppForPublic(req, res);
        if (!app) return undefined;
        const pages = await studioAppStore.listPublicPages(app.id);
        return res.json({
            pages: pages.map((p) => publicPageView(p, req)),
            publicAccess: (app.definition && app.definition.publicAccess) || null,
            blockers: publicPageBlockers(app),
        });
    } catch (err) {
        log.error('[StudioApps] list public pages failed:', err.message);
        return res.status(500).json({ error: 'Failed to load public pages' });
    }
});

router.post('/:id/public-pages', requireAuth, requireManageApps, async (req, res) => {
    try {
        const app = await loadOwnedAppForPublic(req, res);
        if (!app) return undefined;
        // One live URL per app is the shape the UI needs; rotating means
        // revoking the old one explicitly, so a link already handed out never
        // dies by accident.
        const existing = await studioAppStore.listPublicPages(app.id);
        if (existing.length >= MAX_PUBLIC_PAGES_PER_APP) {
            return res.status(409).json({ error: `An app can have at most ${MAX_PUBLIC_PAGES_PER_APP} public URLs — revoke one first.` });
        }
        const page = await studioAppStore.createPublicPage(app.id, req.session.user.id);
        // The single largest exposure change the studio can make: from here the
        // app answers to anyone on the internet with the link, with no account.
        await publicationAudit.auditPublicPage({
            app, actorId: req.session.user.id, token: page?.token, created: true,
        });
        return res.status(201).json({
            page: publicPageView({ ...page, createdAt: new Date().toISOString(), lastSeenAt: null }, req),
            blockers: publicPageBlockers(app),
        });
    } catch (err) {
        log.error('[StudioApps] mint public page failed:', err.message);
        return res.status(500).json({ error: 'Failed to create a public page' });
    }
});

router.delete('/:id/public-pages/:token', requireAuth, requireManageApps, async (req, res) => {
    try {
        const app = await loadOwnedAppForPublic(req, res);
        if (!app) return undefined;
        const ok = await studioAppStore.deletePublicPage(req.params.token, app.id);
        if (!ok) return res.status(404).json({ error: 'Public page not found' });
        await publicationAudit.auditPublicPage({
            app, actorId: req.session.user.id, token: req.params.token, created: false,
        });
        return res.json({ success: true });
    } catch (err) {
        log.error('[StudioApps] revoke public page failed:', err.message);
        return res.status(500).json({ error: 'Failed to revoke the public page' });
    }
});

/**
 * POST /:id/check — pre-flight the DRAFT, read-only. Owner-only.
 *
 * appDryRun has existed since Wave 4 but only the AI builder could reach it
 * (the app_dry_run tool). A person building by hand had no way to ask "will
 * this actually work?" short of publishing and clicking through the app: the
 * static cross-check ran at publish time and refused the publish, and the
 * things it CANNOT see statically — a component bound to an empty table, a
 * screen that is blank for everyone but the owner — were not checked at all.
 *
 * Body: { screenId?, asRole? }. Never mutates: the DATA pass executes bindings
 * read-only with a limit, and the ACTION pass only static-checks mutating
 * steps against the model.
 *
 * The same 404/403 shape as the publish route above — a reader gets 403, a
 * stranger the uniform 404 so existence never leaks.
 */
router.post('/:id/check', requireAuth, validate({ body: CheckBody }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app) return res.status(404).json({ error: 'App not found' });

        if (!studioAppStore.canWriteStudioApp(app, userId)) {
            const { orgIdArr, userGroups } = await audienceFor(req);
            if (studioAppStore.canReadStudioApp(app, userId, userGroups, orgIdArr)) {
                return res.status(403).json({ error: 'Only the owner can check this app' });
            }
            return res.status(404).json({ error: 'App not found' });
        }

        const { screenId, asRole } = req.body || {};
        // Canonicalize first, exactly as publish does, so the check reports on
        // the bytes that would actually be frozen rather than on a draft shape
        // canonicalize would have altered.
        const { def: canonical } = canonicalizeAppDefinition(app.definition);
        const { dataModel, datasets, datatables } = await loadDataRefs(req.params.id, app.userId);
        const ownedAutomations = await loadOwnedAutomations(app.userId);

        const { appDryRun } = require('../appStudio/appDryRun');
        const result = await appDryRun(
            { def: canonical, dataModel, datasets, datatables, app, ownerId: app.userId },
            {
                screenId: typeof screenId === 'string' && screenId ? screenId : null,
                asRole: typeof asRole === 'string' && asRole ? asRole : null,
            },
        );

        // appDryRun's STATIC pass has no automations list, so it cannot see a
        // dangling/inactive/foreign routine — the one class of error that
        // blocks publish and that a hand-builder is most likely to create (by
        // deleting or deactivating a routine an action points at). Re-run the
        // validator with them so the check and the publish gate agree.
        // …with the owner's Studio tables, exactly like the draft-save and the
        // publish gate: without that list every binding on a LINKED table came
        // back as `binding.datatable_unverified` — five warnings on an app the
        // AI builder had just linked, which the author could not act on and
        // which the publish gate itself never raises.
        const withRoutines = validateAppDefinition(canonical, { ownedAutomations, dataModel, datasets, datatables });
        res.json({
            ...result,
            ok: result.ok && withRoutines.ok,
            static: { errors: withRoutines.errors, warnings: withRoutines.warnings },
        });
    } catch (err) {
        log.error('[StudioApps] Check failed:', err);
        res.status(500).json({ error: 'Could not check this app' });
    }
});

/**
 * POST /:id/template-upgrade — upgrade a PRISTINE created-from-template app to
 * the registry template's current (newer) version. Owner-only, same 404/403
 * shape as publish/check. Refusals are 409 with a machine code:
 *
 *   not_from_template  — no template stamp on the app (blank / pre-feature)
 *   template_missing   — the stamped template is no longer registered
 *   no_newer_version   — registry version ≤ the installed version
 *   not_pristine       — the definition was hand-edited since install
 *
 * On success the definition is REPLACED by the registry template's current
 * definition (canonicalized; the app's in-app name carries over, mirroring
 * the create path's name override), the data side re-runs through
 * installTemplate with seedMode 'missing-tables-only' (migration diff applies;
 * seed rows go only into tables that currently hold zero rows, so existing
 * data is never duplicated), and the template stamp moves to the new
 * version + hash. → { ok:true, fromVersion, toVersion, version, dataInstall? }
 */
router.post('/:id/template-upgrade', requireAuth, requireManageApps, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app) return res.status(404).json({ error: 'App not found' });

        if (!studioAppStore.canWriteStudioApp(app, userId)) {
            const { orgIdArr, userGroups } = await audienceFor(req);
            if (studioAppStore.canReadStudioApp(app, userId, userGroups, orgIdArr)) {
                return res.status(403).json({ error: 'Only the owner can upgrade this app' });
            }
            return res.status(404).json({ error: 'App not found' });
        }

        if (!app.templateId || !app.templateInstallHash) {
            return res.status(409).json({ error: 'This app was not created from a template', code: 'not_from_template' });
        }
        const { orgIdArr: upgradeOrgIds } = await audienceFor(req);
        const template = await resolveTemplate(app.templateId, { userId, orgIds: upgradeOrgIds });
        if (!template) {
            return res.status(409).json({ error: 'The template this app came from is no longer available', code: 'template_missing' });
        }
        const cand = upgradeCandidate(app, template);
        if (!cand) {
            return res.status(409).json({ error: 'The app already runs the latest template version', code: 'no_newer_version' });
        }
        if (!isPristine(app)) {
            return res.status(409).json({
                error: 'The app was modified after install — upgrading would overwrite those changes',
                code: 'not_pristine',
            });
        }

        // Replace the definition with the registry's current one — deep-cloned
        // and canonicalized exactly like the create path, with the app's
        // current in-app name carried over (it was the create-time override,
        // and the hash below covers whatever is actually saved).
        const copy = JSON.parse(JSON.stringify(template.definition));
        const currentName = app.definition?.meta?.name;
        if (typeof currentName === 'string' && currentName) {
            copy.meta = { ...(copy.meta || {}), name: currentName };
        }
        const { def: canonical } = canonicalizeAppDefinition(copy);

        // Unconditional save (no expectedVersion): pristine was just verified,
        // and the version bump makes any open editor's CAS save conflict
        // instead of silently clobbering the upgrade.
        const saved = await studioAppStore.saveDefinition(req.params.id, userId, canonical);
        if (!saved || !saved.ok) {
            return res.status(500).json({ error: 'Failed to save the upgraded definition' });
        }

        // Data side: migration diff + missing-tables-only seeding. Best-effort
        // like the create path — the definition upgrade already landed, so a
        // data hiccup is reported, not turned into a 500.
        let dataInstall = null;
        if (template.dataModel || template.seed || template.datasets) {
            try {
                const install = await installTemplate({
                    appId: app.id, ownerId: userId, template, seedMode: 'missing-tables-only',
                });
                dataInstall = (install && install.ok)
                    ? { ok: true, dataModelVersion: install.dataModelVersion }
                    : { ok: false, error: (install && install.error) || 'unknown error' };
                if (!dataInstall.ok) log.warn(`[StudioApps] Template upgrade data install failed for ${app.id}: ${dataInstall.error}`);
            } catch (e) {
                const reason = e && e.message ? e.message : String(e);
                log.warn(`[StudioApps] Template upgrade data install threw for ${app.id}: ${reason}`);
                dataInstall = { ok: false, error: reason };
            }
        }

        // Move the stamp: the app now runs toVersion, and pristine-ness is
        // measured against the definition as just re-installed.
        await studioAppStore.setTemplateStamp(app.id, userId, {
            templateVersion: cand.toVersion,
            templateInstallHash: hashDefinition(canonical),
        });

        res.json({
            ok: true,
            fromVersion: cand.fromVersion,
            toVersion: cand.toVersion,
            version: saved.version,
            ...(dataInstall ? { dataInstall } : {}),
        });
    } catch (err) {
        log.error('[StudioApps] Template upgrade failed:', err);
        res.status(500).json({ error: 'Failed to upgrade the app' });
    }
});

router.delete('/:id', requireAuth, requireManageApps, async (req, res) => {
    try {
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
    } catch (err) {
        log.error('[StudioApps] Delete failed:', err);
        res.status(500).json({ error: 'Failed to delete app' });
    }
});

// ── Publish-version history (owner-only) ────────────────────────────

router.get('/:id/versions', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app || app.userId !== userId) return res.status(404).json({ error: 'App not found' });
        const versions = await studioAppStore.listVersions(req.params.id, userId);
        res.json({ versions });
    } catch (err) {
        log.error('[StudioApps] List versions failed:', err);
        res.status(500).json({ error: 'Failed to list versions' });
    }
});

router.post('/:id/versions/:versionId/restore', requireAuth, requireManageApps, async (req, res) => {
    try {
        const userId = req.session.user.id;
        // restoreVersion is scoped to app AND owner; it bumps definition_version
        // so open editors' CAS saves conflict instead of clobbering the restore.
        const updated = await studioAppStore.restoreVersion(req.params.id, req.params.versionId, userId);
        if (!updated) return res.status(404).json({ error: 'Version not found' });
        res.json({ success: true, version: updated.definitionVersion });
    } catch (err) {
        log.error('[StudioApps] Restore version failed:', err);
        res.status(500).json({ error: 'Failed to restore version' });
    }
});

// ── Runtime read (the run-view payload) ─────────────────────────────

// The CALLER'S OWN identity + resolved app role, feeding the run view's
// formula scope (currentUser) and presentational role gate (previewRole).
// Role resolution is the canonical rlsGateway path (owner → members row →
// roleMapping.byGroup → roleMapping.default → null); the data model is read
// acts-as-owner, same as studioAppsRun.js. Only the viewer's own fields go
// out — never another user's row, never role/enforcement config.
async function buildRuntimeViewer(app, userId, userGroups) {
    const isOwner = app.userId === userId;
    let roleKey = 'owner';
    if (!isOwner) {
        let model = null;
        try {
            const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
            model = (meta && meta.model) ? meta.model : null;
        } catch { /* no data model → membership/mapping-less resolution */ }
        roleKey = await rlsGateway.resolveViewerRole(app, userId, model, { userGroups });
    }
    let user = null;
    try { user = await userStore.getUser(userId); } catch { /* name/email stay null */ }
    return {
        id: userId,
        name: user?.displayName || user?.name || user?.username || null,
        email: user?.email || null,
        isOwner,
        roleKey,
    };
}

router.get('/:id/runtime', requireAuth, validate({ query: DraftQuery }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const app = await studioAppStore.getStudioApp(req.params.id);
        if (!app) return res.status(404).json({ error: 'App not found' });

        // Owner previewing the working draft.
        if (app.userId === userId && String(req.query.draft || '') === '1') {
            return res.json({
                id: app.id,
                name: app.name,
                icon: app.icon,
                accentColor: app.accentColor,
                definition: app.definition,
                viewer: await buildRuntimeViewer(app, userId, []),
                draft: true,
                appVersion: app.definitionVersion ?? null,
            });
        }

        // Everyone else (owner included) runs the frozen published copy.
        // Unpublished apps 404 for non-owners — never leak existence.
        if (!app.isPublished || !app.publishedDefinition) {
            return res.status(404).json({ error: 'App not found' });
        }
        const { orgIdArr, userGroups } = await audienceFor(req);
        if (!await studioAppStore.canReadStudioAppAsync(app, userId, userGroups, orgIdArr)) {
            return refuseRead(res, app, orgIdArr);
        }
        res.json({
            id: app.id,
            name: app.name,
            icon: app.icon,
            accentColor: app.accentColor,
            definition: app.publishedDefinition,
            viewer: await buildRuntimeViewer(app, userId, userGroups),
            // Which published generation this session is running. Every data
            // response carries the same number, so a long-open session can
            // notice that the owner has republished — until now it kept
            // rendering an old definition against the new schema and RLS, with
            // nothing on screen saying so.
            appVersion: app.publishedVersion ?? null,
        });
    } catch (err) {
        log.error('[StudioApps] Runtime read failed:', err);
        res.status(500).json({ error: 'Failed to load app' });
    }
});

module.exports = router;

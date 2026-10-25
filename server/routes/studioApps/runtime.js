// @typecheck
/**
 * Pre-flight check, template upgrade and the run-view payload (routes/studioApps/).
 */

const express = require('express');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const studioAppStore = require('../../stores/studioAppStore');
const studioAppDataStore = require('../../stores/studioAppDataStore');
const userStore = require('../../stores/userStore');
const rlsGateway = require('../../appStudio/rlsGateway');
const { canonicalizeAppDefinition } = require('../../appStudio/canonicalize');
const { validateAppDefinition } = require('../../appStudio/validate');
const { resolveTemplate } = require('../../appStudio/templateRegistry');
const { installTemplate } = require('../../appStudio/templateInstall');
const { hashDefinition, isPristine, upgradeCandidate } = require('../../appStudio/templateUpgrade');
const { requireAuth } = require('../../auth/permissions');
const { CheckBody, DraftQuery } = require('./schemas');
const { requireManageApps, audienceFor, refuseRead } = require('./access');
const { loadOwnedAutomations, loadDataRefs } = require('./appHelpers');
const { fallback } = require('../../utils/bestEffort');

const router = express.Router();

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
router.post('/:id/check', requireAuth, validate({ body: CheckBody }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
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

    const { appDryRun } = require('../../appStudio/appDryRun');
    const result = await appDryRun(
        { def: canonical, dataModel, datasets, datatables, app, ownerId: app.userId },
        {
            screenId: typeof screenId === 'string' && screenId ? screenId : null,
            asRole: typeof asRole === 'string' && asRole ? asRole : null,
        },
    );

    // appDryRun's STATIC pass has no automations list, so it cannot see a
    // dangling/inactive/foreign automation — the one class of error that
    // blocks publish and that a hand-builder is most likely to create (by
    // deleting or deactivating an automation an action points at). Re-run the
    // validator with them so the check and the publish gate agree.
    // …with the owner's Studio tables, exactly like the draft-save and the
    // publish gate: without that list every binding on a LINKED table came
    // back as `binding.datatable_unverified` — five warnings on an app the
    // AI builder had just linked, which the author could not act on and
    // which the publish gate itself never raises.
    const withAutomations = validateAppDefinition(canonical, { ownedAutomations, dataModel, datasets, datatables });
    res.json({
        ...result,
        ok: result.ok && withAutomations.ok,
        static: { errors: withAutomations.errors, warnings: withAutomations.warnings },
    });
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
router.post('/:id/template-upgrade', requireAuth, requireManageApps, /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
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
    const template = /** @type {{ definition: object, dataModel?: object, seed?: object, datasets?: object, [key: string]: any }|null} */ (await resolveTemplate(app.templateId, { userId, orgIds: upgradeOrgIds }));
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
        throw new Error('Failed to save the upgraded definition');
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
});

// ── Runtime read (the run-view payload) ─────────────────────────────

// The CALLER'S OWN identity + resolved app role, feeding the run view's
// formula scope (currentUser) and presentational role gate (previewRole).
// Role resolution is the canonical rlsGateway path (owner → members row →
// roleMapping.byGroup → roleMapping.default → null); the data model is read
// acts-as-owner, same as studioAppsRun.js. Only the viewer's own fields go
// out — never another user's row, never role/enforcement config.
/**
 * @param {NonNullable<Awaited<ReturnType<typeof studioAppStore.getStudioApp>>>} app
 * @param {string} userId
 * @param {string[]} userGroups
 */
async function buildRuntimeViewer(app, userId, userGroups) {
    const isOwner = app.userId === userId;
    let roleKey = 'owner';
    if (!isOwner) {
        let model = null;
        try {
            const meta = await studioAppDataStore.getDataModel(app.id, app.userId);
            model = (meta && meta.model) ? meta.model : null;
        } catch (err) { fallback('routes/studioApps/runtime:buildRuntimeViewer', err); /* no data model → membership/mapping-less resolution */ }
        roleKey = await rlsGateway.resolveViewerRole(app, userId, model, { userGroups });
    }
    let user = null;
    try { user = await userStore.getUser(userId); } catch (err) { fallback('routes/studioApps/runtime:buildRuntimeViewer#2', err); /* name/email stay null */ }
    return {
        id: userId,
        name: user?.displayName || user?.name || user?.username || null,
        email: user?.email || null,
        isOwner,
        roleKey,
    };
}

router.get('/:id/runtime', requireAuth, validate({ query: DraftQuery }), /** @param {import('express').Request<{ id: string }>} req */ async (req, res) => {
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
});

module.exports = router;

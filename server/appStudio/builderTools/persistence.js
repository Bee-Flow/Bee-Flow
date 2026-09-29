/**
 * App Studio builder tools — write-through persistence to studio_apps
 * (persistDraft, the CAS seam every mutating tool ends in) and app_finalize
 * (validate-then-save).
 */

'use strict';

const { LIMITS } = require('../componentSpecs');
const { canonicalizeAppDefinition } = require('../canonicalize');
const { validateAppDefinition } = require('../validate');
const ops = require('../definitionOps');
const { ensureAppName } = require('./appNaming');

/**
 * The default "Home" screen a new app starts with, still empty while the
 * build put its screens beside it: dropped at finalize (homeScreenId moves
 * to the first real screen). Measured 2026-09-14 — every playbook app opened
 * on a blank Home. Returns the screen it removed, or null.
 */
function dropEmptyDefaultHome(def) {
    const screens = Array.isArray(def?.screens) ? def.screens : [];
    if (screens.length < 2) return { def, removed: null };
    const home = screens.find((s) => s && String(s.name || '').trim().toLowerCase() === 'home'
        && (s.sections || []).every((sec) => !sec || !Array.isArray(sec.children) || sec.children.length === 0));
    if (!home) return { def, removed: null };
    // Nothing may point at it (a navigate action would dangle).
    const referenced = JSON.stringify(def.actions || {}).includes(`"${home.id}"`);
    if (referenced) return { def, removed: null };
    return { def: ops.removeScreen(def, home.id), removed: home };
}

// ── Finalize ─────────────────────────────────────────────────────────

async function applyFinalize(draftWrap) {
    // A draft the model never named is named here, from the brief the route
    // stored on the wrap (_turnMessage), the tables or the screens — before
    // the row is saved under "Untitled app" for good. Both finalize paths
    // (the model's own app_finalize and the route's auto-finalize net) come
    // through this function, so the net has one place. Silent when the model
    // did its job; a hint on the result when it did not.
    const namedHint = ensureAppName(draftWrap);
    // Re-canonicalize defensively (the draft should already be canonical).
    const dropped = dropEmptyDefaultHome(draftWrap.def);
    const { def } = canonicalizeAppDefinition(dropped.def);
    draftWrap.def = def;

    // Best-effort owned-routines check so a wired automationId the owner does
    // not actually have blocks finalize with a precise, fixable error.
    let ownedAutomations;
    try {
        const automationStore = require('../../stores/automationStore');
        const rows = await automationStore.getAutomationsForUser(draftWrap.userId);
        ownedAutomations = (rows || []).map((a) => ({ id: a.id, isActive: true }));
    } catch (_) { ownedAutomations = undefined; }

    // Data-reference cross-checks: the route loads the app's data model +
    // dataset ids onto the draftWrap each turn (read-only). When it did, a
    // binding/step referencing a nonexistent table/dataset/field blocks
    // finalize; when it did not (dataModel === undefined) the checks are
    // skipped — validate.js's opts contract.
    // De Studio-datatabellen van de eigenaar, langs dezelfde helper als de
    // publicatiepoort: zonder die lijst is een `source.datatableId` die nergens
    // naar wijst hier alleen een waarschuwing, en de AI-builder is juist het pad
    // dat zo'n id kan verzinnen.
    const datatables = draftWrap._ownerDatatables || await require('../datatableSource').listOwnerDatatableIds(draftWrap.userId);
    const validation = validateAppDefinition(def, {
        ownedAutomations,
        dataModel: draftWrap.dataModel,
        datasets: draftWrap.datasetIds,
        datatables,
    });
    if (!validation.ok) {
        return {
            error: 'Cannot finalize: the definition has validation errors. Fix every error below, then call app_finalize again.',
            validation: { errors: validation.errors, warnings: validation.warnings },
        };
    }
    const persisted = await persistDraft(draftWrap, { finalize: true });
    if (persisted.error) return persisted;
    draftWrap.finalized = true;
    const hints = [
        ...(namedHint ? [namedHint] : []),
        ...(dropped.removed ? [`The empty default "Home" screen (${dropped.removed.id}) was removed — the app opens on "${(def.screens || []).find((s) => s.id === def.homeScreenId)?.name || def.screens[0].name}".`] : []),
    ];
    return {
        finalized: true,
        appId: draftWrap.appId,
        version: draftWrap.version,
        name: def.meta?.name || 'Untitled app',
        ...(validation.warnings.length ? { warnings: validation.warnings } : {}),
        ...(hints.length ? { _hints: hints } : {}),
    };
}

// ── Persistence ──────────────────────────────────────────────────────

const CONFLICT_ERROR = 'Someone else saved this app at the same time (version conflict). Close other editor tabs for this app and try again.';

/**
 * Write the draft through to studio_apps. First mutation creates the row
 * (name from meta, org backfilled from the user record when the session
 * didn't carry one); afterwards a CAS save against the tracked version.
 * On a CAS conflict: adopt the server's currentVersion and retry ONCE —
 * still conflicting means a live concurrent editor, so return an error
 * result the route surfaces as an `error` SSE event. Never throws for
 * expected failure modes.
 */
async function persistDraft(draftWrap, { finalize = false } = {}) {
    void finalize; // studio_apps has no draft flag — finalize is validate-then-save.
    const studioAppStore = require('../../stores/studioAppStore');
    const def = draftWrap.def;

    try {
        if (!draftWrap.appId) {
            // Org backfill — same trick as automation/builderTools.persistDraft:
            // a row created with organization_id NULL would bypass org-scoped
            // gates later. Best-effort; keep null if the user has no org.
            let orgId = draftWrap.orgId || null;
            if (!orgId && draftWrap.userId) {
                try {
                    const userStore = require('../../stores/userStore');
                    const u = await userStore.getUser(draftWrap.userId);
                    orgId = u?.organizationId || null;
                    if (orgId) draftWrap.orgId = orgId; // memoize
                } catch (_) { /* keep null */ }
            }
            const row = await studioAppStore.createStudioApp({
                userId: draftWrap.userId,
                organizationId: orgId,
                name: def?.meta?.name || 'Untitled app',
                description: def?.meta?.description || '',
                icon: def?.meta?.icon || null,
                definition: def,
            });
            draftWrap.appId = row.id;
            draftWrap.version = row.definitionVersion;
            return { ok: true, appId: row.id, version: row.definitionVersion, created: true };
        }

        let res = await studioAppStore.saveDefinition(draftWrap.appId, draftWrap.userId, def, {
            expectedVersion: draftWrap.version ?? null,
        });
        if (res.conflict) {
            // Another writer bumped the version (e.g. an autosaving editor tab).
            // Adopt the server's version and retry ONCE — the builder's def wins.
            res = await studioAppStore.saveDefinition(draftWrap.appId, draftWrap.userId, def, {
                expectedVersion: res.currentVersion,
            });
        }
        if (res.ok) {
            draftWrap.version = res.version;
            await syncCardMeta(draftWrap);
            return { ok: true, appId: draftWrap.appId, version: res.version };
        }
        if (res.notFound) {
            return { error: 'This app no longer exists — it may have been deleted in another tab. Start a new app.' };
        }
        return { error: CONFLICT_ERROR };
    } catch (e) {
        if (e && e.code === 'definition_too_large') {
            return { error: `The app definition exceeds the ${LIMITS.MAX_DEFINITION_BYTES}-byte limit — trim large static values (bind data from routines instead of inlining it).` };
        }
        return { error: `Could not save the draft: ${e.message}` };
    }
}

/**
 * Keep the list-card columns (name/description/icon) in step with the
 * definition's meta after app_set_meta. Best-effort — the definition is the
 * source of truth; a failed card sync never fails the save.
 */
async function syncCardMeta(draftWrap) {
    const meta = draftWrap.def?.meta;
    if (!meta) return;
    const key = `${meta.name}\u0000${meta.description}\u0000${meta.icon}`;
    if (draftWrap._syncedMetaKey === key) return;
    try {
        const studioAppStore = require('../../stores/studioAppStore');
        await studioAppStore.updateStudioApp(draftWrap.appId, {
            name: meta.name || 'Untitled app',
            description: meta.description || '',
            icon: meta.icon || null,
        }, draftWrap.userId);
        draftWrap._syncedMetaKey = key;
    } catch (_) { /* card meta is cosmetic */ }
}

module.exports = {
    dropEmptyDefaultHome,
    applyFinalize,
    persistDraft,
};

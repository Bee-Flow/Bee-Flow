/**
 * MOVING A PLAYBOOK ALONG — the work every route group does between loading
 * the row and answering: resolve the recipe behind it, load the caller's own
 * playbook, compose a phase's brief, make the next phase ready (pre-creating
 * the app, locking what the licence does not allow, skipping what the table
 * cannot support), and write the result back under its version.
 *
 * One factory over the dependency object, so each function below is the body
 * it had inside createPlaybooksRouter, unchanged.
 */

'use strict';

const lifecycle = require('../../playbooks/lifecycle');
const { copyFor } = require('../../playbooks/copy');
const { userIdOf } = require('../studio/shared');
const { tierRefusal } = require('../../core/entitlements/tierAccess');
const { sendErr } = require('./contract');
const { kindOf, firstOfKind, appBefore, tierOf, localeOf } = require('./phaseList');
const log = require('../../telemetry/log');

// The tier a request runs on when nobody picked one -- the project's default,
// named in the refusal when not even that is left to choose.
const DEFAULT_TIER = 'fast';

function makeFlow(d) {
    /** The recipe a playbook runs on: its own document, or the built-in module. */
    const resolveRecipe = (pb) => (pb && pb.recipe ? d.recipeDoc.fromDocument(pb.recipe) : d.recipes.getRecipe(pb && pb.recipeId));

    const approvalsAllowed = async (req) => {
        try {
            return !!(await d.entitlements.hasCapability('approvals', { userId: userIdOf(req), orgId: req.session?.user?.organizationId || null, session: req.session, req }));
        } catch { return false; }
    };

    const resolveOwnerOrgId = async (userId) => {
        try {
            const owner = await d.userStore.getUser(userId);
            let organizationId = owner?.organizationId || null;
            if (!organizationId) {
                const groups = Array.isArray(owner?.groups) ? owner.groups : (() => { try { return JSON.parse(owner?.groups || '[]'); } catch { return []; } })();
                if (groups.length) {
                    const all = await d.userStore.getAllGroups();
                    const g = (all || []).find((x) => groups.includes(x.id) && x.organizationId);
                    organizationId = g?.organizationId || null;
                }
            }
            return organizationId;
        } catch { return null; }
    };

    const load = async (req, res) => {
        const pb = await d.playbookStore.getPlaybook(req.params.id, userIdOf(req));
        if (!pb) { sendErr(res, 404, 'not_found', 'Not found'); return null; }
        return pb;
    };

    /** Compose the brief of `key` (route-level glue: recipe + playbook). */
    const withBrief = (recipe, playbook, phases, key) => {
        const phase = lifecycle.phaseByKey(phases, key);
        if (!phase || phase.briefEdited) return phases;
        const brief = lifecycle.composeBriefFor(recipe, key, { ...playbook, phases });
        return phases.map((p) => (p.key === key ? { ...p, brief, briefVersion: recipe.BRIEF_VERSION } : p));
    };

    /**
     * A phase that was just skipped or locked passes the turn to the one after
     * it: that becomes ready and is prepared in its turn. Bounded by the phase
     * list — every hop makes one more phase terminal.
     */
    const prepareAfter = async (recipe, playbook, phases, key, req) => {
        const after = lifecycle.nextPhaseKey(phases, key);
        if (!after) return phases;
        let out = phases;
        const p = lifecycle.phaseByKey(out, after);
        if (p && (p.status === 'pending' || p.status === 'failed' || p.status === 'skipped')) out = lifecycle.applyTransition(out, after, 'ready', {}, new Date(d.now()).toISOString());
        return prepareNext(recipe, playbook, out, after, req);
    };

    /**
     * After a phase became done/skipped: the next phase is ready with its
     * brief; the app is pre-created before `app`; `approvals` is skipped when
     * the table has no status column. Returns the phases.
     */
    const prepareNext = async (recipe, playbook, phases, nextKey, req) => {
        if (!nextKey) return phases;
        let out = phases;
        const next = lifecycle.phaseByKey(out, nextKey);
        if (!next) return out;
        const tableArt = (firstOfKind(out, 'table') || {}).artifacts || {};
        // A phase that needs a column the chosen table does not have (the
        // approval turn writes `status`) is skipped with the reason.
        if (next.requiresRole && tableArt.mapping && !tableArt.mapping[next.requiresRole]) {
            const role = next.requiresRole;
            const copy = copyFor(localeOf(playbook));
            out = lifecycle.applyTransition(out, nextKey, 'skipped', { error: role === 'status' ? 'no_status_column' : `no_${role}_column`, summary: role === 'status' ? copy.skippedNoStatus : copy.skippedNoColumn(role) });
            // A phase that steps aside hands the turn on — it does not end the
            // playbook. (It always used to be the last one, so nothing noticed
            // until a phase was added after it.)
            return prepareAfter(recipe, playbook, out, nextKey, req);
        }
        if (next.requires === 'approvals') {
            const allowed = await approvalsAllowed(req);
            if (!allowed) {
                if (next.status !== 'locked') out = lifecycle.applyTransition(out, nextKey, 'locked');
                return prepareAfter(recipe, playbook, out, nextKey, req);
            }
        }
        if (kindOf(next) === 'app' && !(next.artifacts && next.artifacts.appId)) {
            const row = await d.studioAppStore.createStudioApp({
                userId: playbook.userId, organizationId: playbook.organizationId,
                name: playbook.title || 'App', description: copyFor(localeOf(playbook)).appDescription, icon: 'Receipt',
            });
            // Every later turn on the app — and the access phase that closes
            // the playbook — reads the same id.
            out = out.map((p) => (p.key === nextKey || kindOf(p) === 'app_turn' || kindOf(p) === 'access' ? { ...p, artifacts: { ...(p.artifacts || {}), appId: row.id } } : p));
        }
        // An access phase with no app before it has nothing to govern.
        if (kindOf(next) === 'access' && !(next.artifacts && next.artifacts.appId)) {
            const appId = appBefore(out, nextKey);
            if (!appId) {
                const copy = copyFor(localeOf(playbook));
                out = lifecycle.applyTransition(out, nextKey, 'skipped', { error: 'no_app', summary: copy.skippedNoApp });
                return prepareAfter(recipe, playbook, out, nextKey, req);
            }
            out = out.map((p) => (p.key === nextKey ? { ...p, artifacts: { ...(p.artifacts || {}), appId } } : p));
        }
        try {
            out = withBrief(recipe, playbook, out, nextKey);
        } catch (e) {
            if (e.code !== 'artifacts_missing') throw e;
        }
        return out;
    };

    const persist = async (res, playbook, patch, expectedVersion) => {
        const saved = await d.playbookStore.savePhases(playbook.id, playbook.userId, patch, { expectedVersion });
        if (!saved.ok && saved.conflict) { sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: saved.currentVersion, playbook: saved.playbook }); return null; }
        if (!saved.ok) { sendErr(res, 404, 'not_found', 'Not found'); return null; }
        return saved.playbook;
    };

    /**
     * The CLOSING write of a server-run phase (table/design/compliance). A
     * conflict here used to answer 409 and leave the stored phase `running`
     * for ever: `running → ready` is illegal, the client offers Skip only for
     * the client-run kinds, and GET heals fill alone — so the phase, and the
     * page's 2 s poll with it, never ended (owner, 2026-09-17). Heal instead:
     * re-read, fail a phase still marked running so its Retry works, and hand
     * the healed row back with the 409.
     */
    const savePhaseOutcome = async (pb, key, phases, version) => {
        const saved = await d.playbookStore.savePhases(pb.id, pb.userId, { phases, currentPhase: key }, { expectedVersion: version });
        if (saved.ok || !saved.conflict) return saved;
        try {
            const fresh = await d.playbookStore.getPlaybook(pb.id, pb.userId);
            const cur = fresh && lifecycle.phaseByKey(fresh.phases, key);
            if (cur && cur.status === 'running') {
                // Carry the in-flight artifacts onto the failure: the table
                // phase's datatableId is what lets a retry REUSE the table
                // that was already created instead of making a second one.
                const inflight = lifecycle.phaseByKey(phases, key);
                const failed = lifecycle.applyTransition(fresh.phases, key, 'failed', {
                    error: 'This playbook changed elsewhere mid-write — the phase was marked failed so you can retry it.',
                    ...(inflight && inflight.artifacts && Object.keys(inflight.artifacts).length ? { artifacts: inflight.artifacts } : {}),
                }, new Date(d.now()).toISOString());
                const healed = await d.playbookStore.savePhases(fresh.id, fresh.userId, { phases: failed, currentPhase: key }, { expectedVersion: fresh.version });
                if (healed.ok) return { ...saved, playbook: healed.playbook };
            }
        } catch (e) {
            log.warn('[Playbooks] could not fail the phase after a save conflict:', e.message);
        }
        return saved;
    };

    /**
     * WHICH TIER THIS RUNS ON, measured against the person's own list
     * (core/entitlements/tierAccess, taskType automation: what the
     * new-playbook dialog and both builders offer). `asked` is a tier name,
     * or nothing for "the default".
     *
     * An explicit tier has to be theirs. `auto` and no tier at all become the
     * cheapest tier they may use, `fast` when it is theirs: no tier used to
     * mean `fast` without asking, and `auto` resolved to the FAST model
     * (modelResolver reads `tier:auto` as an unknown tier), so a group
     * narrowed to `thinking` or to an on-prem tier still ran on fast.
     *
     * Returns the tier, or answers the 403 in this router's envelope and
     * returns null -- the caller returns, the way it does after a sendErr.
     */
    const tierFor = async (req, res, asked, userId = userIdOf(req)) => {
        const access = await d.tierAccessFor({ userId, session: req.session, taskType: 'automation' });
        const tier = access.choose(asked);
        if (tier) return tier;
        const refusal = tierRefusal(asked === undefined || asked === null ? DEFAULT_TIER : asked);
        sendErr(res, refusal.status, refusal.code, refusal.error);
        return null;
    };

    /**
     * The tier a playbook's OWN model calls run on -- the design, the
     * compliance review, the access assistant and "resolve with AI": the tier
     * on file, measured again NOW against the owner's list. It was read
     * straight off the row, so a playbook stored on `auto` ran all four on
     * the fast model, and one created before an administrator narrowed the
     * owner's groups kept its tier for ever. Answers the same 403 as tierFor.
     * Only the owner can load a playbook, so the owner is who is asking.
     */
    const phaseTier = (req, res, pb) => tierFor(req, res, tierOf(pb), pb.userId);

    return {
        resolveRecipe,
        approvalsAllowed,
        resolveOwnerOrgId,
        tierFor,
        phaseTier,
        load,
        withBrief,
        prepareAfter,
        prepareNext,
        persist,
        savePhaseOutcome,
    };
}

module.exports = { makeFlow };

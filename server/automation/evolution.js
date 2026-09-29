/**
 * Routine evolution — a routine proposes changes to its OWN definition, a human
 * approves, the change lands as a new version, the next runs are watched, and
 * a regression rolls back to the exact version it replaced.
 *
 * Boundaries that keep this safe:
 *   - Self-scope only: the tools in integrations/routineEvolutionTools.js act on
 *     the automation that is running them (ctx.automationId), never another.
 *   - Narrow patch vocabulary (ALLOWED_TOOLS): prompt/threshold/binding edits,
 *     a notification, an error branch, a set/filter/condition, a note, metadata.
 *     No trigger changes, no removals, no flowlet surgery — those stay human.
 *   - Nothing is applied without a human click: proposeEvolution stores a row;
 *     applyEvolution is what the approval-decided path calls.
 *   - The plan runs on a COPY through the same builder functions the MCP uses,
 *     is validated, and only then saved (which writes an automation_versions
 *     row). The canary compares the new version's live failure rate with the
 *     30-day baseline captured at apply time.
 *
 * Dependencies are injectable (`deps`) so the unit test needs no database.
 */

const { automationPath } = require('../utils/appPaths');
const log = require('../telemetry/log');

const ALLOWED_TOOLS = new Set([
    'builder_update_step', 'builder_update_steps', 'builder_add_notification', 'builder_wire_error_branch',
    'builder_add_set', 'builder_add_filter', 'builder_add_condition', 'builder_add_note', 'builder_set_metadata',
]);
const MAX_PLAN_STEPS = 12;
const CANARY_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const REGRESSION_MARGIN = 0.10;
const MIN_FAILURES_FOR_ROLLBACK = 3;

function defaultDeps() {
    return {
        store: require('../stores/automationStore'),
        applyToolCall: (...a) => require('./builderTools').applyToolCall(...a),
        validateDefinition: (...a) => require('./validate').validateDefinition(...a),
        getDeliverableEvents: () => { try { return require('./deliverableEvents').getDeliverableEvents(); } catch { return []; } },
        notify: async (n) => { try { await require('../stores/notificationStore').createNotification(n); } catch (e) { log.warn(`[evolution] notify failed: ${e.message}`); } },
        now: () => new Date(),
    };
}

function validatePlan(plan) {
    if (!Array.isArray(plan) || plan.length === 0) return 'plan must be a non-empty array of { tool, args }';
    if (plan.length > MAX_PLAN_STEPS) return `plan has ${plan.length} steps; the maximum is ${MAX_PLAN_STEPS}`;
    for (let i = 0; i < plan.length; i++) {
        const s = plan[i];
        if (!s || typeof s !== 'object') return `plan[${i}] must be an object`;
        if (!ALLOWED_TOOLS.has(s.tool)) return `plan[${i}].tool "${s.tool}" is not allowed; allowed: ${[...ALLOWED_TOOLS].join(', ')}`;
        if (!s.args || typeof s.args !== 'object' || Array.isArray(s.args)) return `plan[${i}].args must be an object`;
    }
    return null;
}

async function summariseRuns(automationId, { days = 30 } = {}, deps = defaultDeps()) {
    const d = Math.max(1, Math.min(365, Number(days) || 30));
    const since = new Date(deps.now().getTime() - d * 24 * 3600 * 1000).toISOString();
    const summary = await deps.store.runOutcomeSummary(automationId, { since });
    return { days: d, since, ...summary };
}

async function proposeEvolution({ automationId, userId, rationale, expectedEffect, risk, plan, canaryRuns }, deps = defaultDeps()) {
    if (!automationId || !userId) throw new Error('automationId and userId are required');
    const err = validatePlan(plan);
    if (err) throw new Error(err);
    const a = await deps.store.getAutomation(automationId);
    if (!a) throw new Error('Automation not found');
    return deps.store.createEvolution({
        automationId, userId,
        rationale: String(rationale || '').slice(0, 4000),
        expectedEffect: String(expectedEffect || '').slice(0, 2000),
        risk: String(risk || '').slice(0, 2000),
        plan, canaryRuns,
    });
}

/**
 * Apply an approved proposal: run its plan on a copy through the builder,
 * validate, save as a new version, capture the baseline, start the canary.
 * Never throws for a plan problem — the row ends in `failed` with the reason,
 * which the calling routine reports to the owner.
 */
async function applyEvolution(evolutionId, { userId } = {}, deps = defaultDeps()) {
    const row = await deps.store.getEvolution(evolutionId);
    if (!row) throw new Error('Evolution not found');
    if (!['proposed', 'approved'].includes(row.status)) return row;
    const a = await deps.store.getAutomation(row.automationId);
    if (!a) return deps.store.updateEvolution(evolutionId, { status: 'failed', error: 'Automation not found' });
    if (userId && a.userId && a.userId !== userId && row.userId !== userId) {
        return deps.store.updateEvolution(evolutionId, { status: 'failed', error: 'Only the routine owner can apply an evolution' });
    }
    const planErr = validatePlan(row.plan);
    if (planErr) return deps.store.updateEvolution(evolutionId, { status: 'failed', error: planErr });
    // The plan is applied to the WORKING copy and saved with goLive (handoff 5
    // live split). With unpublished edits in the working copy that would take
    // those live too, unchecked, and the rollback target would be a version
    // that never ran. Refuse; the owner publishes or discards them first.
    if (a.liveVersion != null && Number(a.pendingChanges) > 0) {
        return deps.store.updateEvolution(evolutionId, {
            status: 'failed',
            error: 'Not applied: the routine has changes that are not live yet, and applying this would make them live unchecked. Make them live (or restore the live version) first.',
        });
    }

    const copy = JSON.parse(JSON.stringify(a.definition || {}));
    const draftWrap = { def: copy, automationId: a.id, userId: a.userId, orgId: a.organizationId || null, title: a.title, description: a.description };
    for (let i = 0; i < row.plan.length; i++) {
        const { tool, args } = row.plan[i];
        let r;
        try { r = await deps.applyToolCall(tool, args, draftWrap); }
        catch (e) { r = { error: e.message }; }
        if (!r || r.error) {
            return deps.store.updateEvolution(evolutionId, { status: 'failed', error: `plan[${i}] ${tool}: ${(r && r.error) || 'no result'}` });
        }
    }
    const v = deps.validateDefinition(copy, { deliverableEvents: deps.getDeliverableEvents() });
    if (!v.ok) {
        const msg = (v.errors || []).slice(0, 5).map(e => `${e.code} ${e.path || ''}: ${e.message}`).join(' | ');
        return deps.store.updateEvolution(evolutionId, { status: 'failed', error: `definition invalid after the plan: ${msg}` });
    }
    // Capture the version BEFORE saving: a store that hands back a live row
    // object would otherwise show the bumped number here, and the rollback
    // would restore the very definition it was meant to undo.
    const versionBefore = a.version ?? null;
    const baseline = await summariseRuns(a.id, { days: 30 }, deps);
    const updates = { definition: copy };
    if (draftWrap.title && draftWrap.title !== a.title) updates.title = draftWrap.title;
    if (typeof draftWrap.description === 'string' && draftWrap.description !== a.description) updates.description = draftWrap.description;
    // goLive: an APPROVED evolution is watched on live runs, so it has to be
    // what runs (handoff 5 live split) — not a pending working copy.
    const saved = await deps.store.updateAutomation(a.id, updates, a.userId, { goLive: true });
    const nowIso = deps.now().toISOString();
    const out = await deps.store.updateEvolution(evolutionId, {
        status: 'canary', versionBefore, versionAfter: saved?.version ?? null, baseline, appliedAt: nowIso, error: null,
    });
    await deps.notify({
        userId: a.userId, category: 'info',
        title: `🧬 ${a.title}: change applied (v${versionBefore} → v${saved?.version})`,
        message: `${row.rationale || 'Evolution applied.'}\n\nThe next ${row.canaryRuns} live runs are watched; a regression rolls back to v${versionBefore} automatically.`,
        link: automationPath(a.id),
    });
    return out;
}

async function rollbackEvolution(evolutionId, { reason = 'manual' } = {}, deps = defaultDeps()) {
    const row = await deps.store.getEvolution(evolutionId);
    if (!row) throw new Error('Evolution not found');
    if (!['canary', 'kept'].includes(row.status)) return row;
    const a = await deps.store.getAutomation(row.automationId);
    if (!a) return deps.store.updateEvolution(evolutionId, { status: 'failed', error: 'Automation not found' });
    const def = Number.isInteger(row.versionBefore) ? await deps.store.getVersionDefinition(a.id, row.versionBefore) : null;
    if (!def) return deps.store.updateEvolution(evolutionId, { status: 'failed', error: `version ${row.versionBefore} has no snapshot to roll back to` });
    await deps.store.updateAutomation(a.id, { definition: def }, a.userId, { goLive: true });
    const out = await deps.store.updateEvolution(evolutionId, {
        status: 'rolled_back', evaluatedAt: deps.now().toISOString(),
        canary: { ...(row.canary || {}), rolledBack: true, reason },
    });
    await deps.notify({
        userId: a.userId, category: 'warning',
        title: `🧬 ${a.title}: change rolled back to v${row.versionBefore}`,
        message: `Reason: ${reason}\n\nThe proposal "${(row.rationale || '').slice(0, 120)}" is marked rolled_back; the routine runs its previous version again.`,
        link: automationPath(a.id),
    });
    return out;
}

/**
 * Judge every canary that has seen enough runs (or waited long enough):
 * failure rate of the new version vs the baseline. Regression = at least
 * MIN_FAILURES_FOR_ROLLBACK failures AND a rate more than REGRESSION_MARGIN
 * above the baseline → rollback; otherwise the change is kept. Called from
 * the scheduler tick; every row is handled independently.
 */
async function evaluateCanaries(deps = defaultDeps()) {
    const rows = await deps.store.listCanaryEvolutions();
    const verdicts = [];
    for (const row of rows) {
        try {
            if (!row.appliedAt) continue;
            const summary = await deps.store.runOutcomeSummary(row.automationId, { since: row.appliedAt, minVersion: row.versionAfter ?? null });
            const age = deps.now().getTime() - new Date(row.appliedAt).getTime();
            if (summary.total < row.canaryRuns && age < CANARY_MAX_AGE_MS) continue;
            const baselineRate = Number(row.baseline?.failureRate || 0);
            const regression = summary.failed >= MIN_FAILURES_FOR_ROLLBACK && summary.failureRate > baselineRate + REGRESSION_MARGIN;
            const canary = { runs: summary.total, failed: summary.failed, failureRate: summary.failureRate, baselineFailureRate: baselineRate, judgedAt: deps.now().toISOString() };
            if (regression) {
                await deps.store.updateEvolution(row.id, { canary });
                await rollbackEvolution(row.id, { reason: `failure rate ${summary.failureRate} vs baseline ${baselineRate} over ${summary.total} runs` }, deps);
                verdicts.push({ id: row.id, verdict: 'rolled_back' });
            } else {
                await deps.store.updateEvolution(row.id, { status: 'kept', canary, evaluatedAt: deps.now().toISOString() });
                const a = await deps.store.getAutomation(row.automationId);
                if (a) await deps.notify({ userId: a.userId, category: 'info', title: `🧬 ${a.title}: change kept (v${row.versionAfter})`, message: `${summary.total} runs watched, failure rate ${summary.failureRate} (baseline ${baselineRate}). The change stays.`, link: automationPath(a.id) });
                verdicts.push({ id: row.id, verdict: 'kept' });
            }
        } catch (e) {
            log.warn(`[evolution] canary ${row.id} evaluation failed: ${e.message}`);
        }
    }
    return verdicts;
}

module.exports = { ALLOWED_TOOLS, MAX_PLAN_STEPS, validatePlan, summariseRuns, proposeEvolution, applyEvolution, rollbackEvolution, evaluateCanaries };

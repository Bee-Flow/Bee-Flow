// §WS5 #4 — automation version history endpoints, extracted verbatim from
// routes/automation.js. summariseDefinitionDiff (used only here) moved in.
//
// None of these routes reads the query, and the restore reads no body: the
// version to restore is in the path and nothing else about it is negotiable.
// Said out loud so that a `?limit=` or a `{ "keepTrigger": true }` that looks
// like it changes the answer is refused by name rather than ignored.
//
// A RESTORE IS A SAVE. It replaces the definition without going through
// PUT /:id, and everything PUT keeps in step with a definition has to be kept
// in step here too — the usage index and the knowledge-base sources (below),
// and the TRIGGER. The scheduler claims rows by the denormalised
// `trigger_type`/`schedule_cron`/`schedule_tz` columns and `next_run_at`,
// never by reading the JSON (automation/triggerColumns.js), and activation
// arms whatever those columns say. The restore wrote `definition` alone, so
// restoring a version with a different trigger left the routine firing on the
// schedule of the version it replaced — or never firing on the schedule it
// now showed — and an active routine's app-event subscription and extra
// schedules kept listening for the old criteria. All under a 200.
//
// The FORM is part of that too. PUT provisions a form trigger's public page
// and its answers table on every save; the restore did neither, and it
// reconciled the dependents index without the answers table's row — the index
// is delete-then-insert, so every restore of a form routine ERASED that row:
// the table stopped naming the routine as a user, and deleting the table no
// longer warned. And a table that was unlinked when collection was switched
// off stayed unlinked after restoring a version that collects, so the form
// said it collected while every answer was dropped (formAnswers/write.js skips
// an unlinked table without a word).
const express = require('express');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
// Handoff 5 sharing: `view` reads the history, `edit` restores a version.
const { makeAutomationAccess, projectForViewer } = require('../../automation/access');
const automationAccess = makeAutomationAccess({ store: automationStore });
const { validateDefinition } = require('../../automation/validate');
const { syncDatatableUsage } = require('../../automation/datatableUsageSync');
const { syncKbSources } = require('../../core/kb/kbSourceSync');
const { triggerColumnsFromDefinition } = require('../../automation/triggerColumns');
const cron = require('../../automation/cron');
const { syncSchedules, scheduleFingerprint } = require('../../automation/scheduleSync');
const { syncAppEventSubscription, hasAppEventTrigger, appEventFingerprint } = require('../../automation/subscriptionSync');
const formAnswers = require('../../automation/formAnswers');
const { validateApprovalAssignees } = require('../../automation/approvalService');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const log = require('../../telemetry/log');

const NoQuery = z.object({}).strict();
/** No body at all (Express 5 leaves `req.body` undefined then) or an empty one. */
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());
const readsNothing = validate({ query: NoQuery });

/**
 * A restored definition's form, provisioned the way PUT /:id provisions it on
 * every save (crud.js keeps that pair private): the public page of each form
 * trigger — the primary one under a NULL step id, the one loadForm reads —
 * and the answers table that follows the form. Best-effort like there: a page
 * or a table never fails a restore. Returns the outcome for the response and
 * the usage row the dependents index needs.
 */
async function provisionForm(automation, definition) {
    const extra = Array.isArray(definition?.triggers) ? definition.triggers : [];
    const pages = [
        ...(definition?.trigger?.kind === 'form' ? [null] : []),
        ...extra.filter((t) => t?.kind === 'form' && t.id).map((t) => t.id),
    ];
    for (const triggerStepId of pages) {
        try { await automationStore.ensureFormPage(automation.id, triggerStepId); }
        catch (e) { log.warn(`[automation restore] form page for ${automation.id}: ${e.message}`); }
    }
    let out;
    try {
        out = await formAnswers.ensureAnswersTable(automation, definition);
    } catch (e) {
        log.warn(`[automation restore] answers table for ${automation.id}: ${e.message}`);
        out = { table: null, error: { code: 'provision_failed', message: 'The answers table could not be updated; saving the routine again retries it.' } };
    }
    if (!out) return { answers: null, usage: [] };
    if (!out.table) return { answers: { datatableId: null, created: false, changed: false, error: out.error || null }, usage: [] };
    return {
        answers: {
            datatableId: out.table.id, created: !!out.created, changed: !!out.changed,
            ...(out.warnings && out.warnings.length ? { warnings: out.warnings } : {}),
        },
        usage: [{ datatableId: out.table.id, stepId: 'trigger:form', mode: 'write', columns: [] }],
    };
}

// Handoff 5 (artboard 5d): the history with live/editing flags and run
// counts, the read-only view, the per-field diff and milestone names.
const { makeVersionHistoryHandlers } = require('./versionHistory');
const history = makeVersionHistoryHandlers({ store: automationStore, access: automationAccess });

router.get('/:id/versions', readsNothing, history.list);

/**
 * §7 — Diff one stored version against another. Both must belong to
 * the same automation. Returns the two definitions plus a coarse
 * change summary the UI uses to seed its side-by-side viewer. Clients
 * compute the actual line/word diff locally.
 */
router.get('/:id/versions/:versionId/diff/:otherVersionId', readsNothing, async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    if (!await automationAccess.guard(req, res, a, 'view')) return;
    const [vA, vB] = await Promise.all([
        automationStore.getVersion(req.params.versionId),
        automationStore.getVersion(req.params.otherVersionId),
    ]);
    if (!vA || !vB) return res.status(404).json({ error: 'Version not found' });
    if (vA.automationId !== a.id || vB.automationId !== a.id) {
        return res.status(400).json({ error: 'Versions do not belong to this automation' });
    }
    const summary = summariseDefinitionDiff(vA.definition, vB.definition);
    res.json({ a: vA, b: vB, summary });
});

/**
 * Read one version's full definition, read-only. `:versionId` is a version
 * row id (as before), a version number, 'live' or 'working'; see
 * versionHistory.js for which definition each stands for.
 */
router.get('/:id/versions/:versionId', readsNothing, history.getOne);

/**
 * Restore a historical version. Loads the version row, validates the
 * historical definition (could fail if step types or tool names have been
 * removed since), then writes it back through the regular updateAutomation
 * path so a new version row gets stamped with this user as the author.
 */
router.post('/:id/versions/:versionId/restore', validate({ body: NoBody, query: NoQuery }), async (req, res) => {
    const userId = req.session.user.id;
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await automationAccess.guard(req, res, a, 'edit');
    if (!access) return;
    // Approvers, subscriptions: the OWNER's, whoever presses Restore.
    const ownerId = a.userId || userId;
    const version = await automationStore.getVersion(req.params.versionId);
    if (!version) return res.status(404).json({ error: 'Version not found' });
    if (version.automationId !== a.id) return res.status(400).json({ error: 'Version does not belong to this automation' });

    const v = validateDefinition(version.definition || {});
    if (!v.ok) return res.status(400).json({ error: 'Stored version no longer validates', details: v.errors });
    // Every other save path (create, PUT, the MCP builder) refuses an approver
    // outside the owner's organisation. The restore wrote one, and at run time
    // approvalLifecycle quietly gave the approval to the OWNER instead — the
    // person the step names was never asked. An approver who has left since
    // the version was saved is exactly the case a restore meets.
    const assigneeErrors = await validateApprovalAssignees(version.definition, ownerId);
    if (assigneeErrors.length) return res.status(400).json({ error: 'Stored version no longer validates', details: assigneeErrors });

    // The trigger columns follow the restored definition, exactly as they do
    // on PUT /:id, and so does next_run_at: computed for a schedule with a
    // cron, cleared for anything else. A cron that no longer parses refuses
    // the restore before anything is written, like any other part of a
    // stored version that no longer validates.
    const columns = triggerColumnsFromDefinition(version.definition);
    let nextRunAt = null;
    if (columns.triggerType === 'schedule' && columns.scheduleCron) {
        try { nextRunAt = cron.nextRunAt(columns.scheduleCron, columns.scheduleTz, Date.now()); }
        catch (e) { return res.status(400).json({ error: `Stored version no longer validates: its schedule "${columns.scheduleCron}" does not parse (${e.message}).` }); }
        if (!nextRunAt) return res.status(400).json({ error: `Stored version no longer validates: its schedule "${columns.scheduleCron}" has no upcoming run time.` });
    }

    // Handoff 5: on a routine with a live version a restore lands in the
    // WORKING copy, like any save — the schedule and triggers keep following
    // the live definition until the restored version is published.
    const hasLive = a.liveVersion != null;
    // Always a new version, described as the restore it is; one that only
    // brings back positions is marked layout-only so it is no pending change.
    const updated = await automationStore.updateAutomation(a.id,
        hasLive ? { definition: version.definition } : { definition: version.definition, ...columns, nextRunAt }, userId,
        {
            forceVersion: true,
            versionMeta: {
                description: `Restored from v${version.version}`,
                descriptionJson: [{ code: 'restored', params: { version: version.version } }],
            },
        });
    const { answers, usage: answersUsage } = await provisionForm(updated || a, version.definition);
    // A restore replaces the definition without going through PUT /:id, so
    // the usage index kept describing the version that was just replaced —
    // steps that no longer exist went on claiming they write to a table. The
    // answers table rides in with the steps, as on PUT: a second writer would
    // erase the step rows, and leaving it out erases the table's.
    await syncDatatableUsage(a.id, a.organizationId || null, version.definition,
        { label: 'automation restore', extraEntries: answersUsage });
    // Same reason: a restore replaces the definition without going through
    // PUT /:id, so a base the restored version stopped writing to would go
    // on claiming a live feed in the Knowledge Studio.
    await syncKbSources(a.id, version.definition, { userId: a.userId || userId, title: a.title });
    // An ACTIVE routine listens on more than the row: its app-event
    // subscription and its additional schedules. Same fingerprint gates as
    // PUT /:id, so restoring a version with the same trigger does not
    // re-anchor a poller cursor or a slot.
    if (!hasLive && (updated?.isActive ?? a.isActive)) {
        const def = version.definition;
        if ((hasAppEventTrigger(def) || hasAppEventTrigger(a.definition))
            && appEventFingerprint(def) !== appEventFingerprint(a.definition)) {
            try { await syncAppEventSubscription(a.id, ownerId, def); }
            catch (e) { log.warn(`[automation restore] subscription re-sync failed for ${a.id}: ${e.message}`); }
        }
        if (scheduleFingerprint(def) !== scheduleFingerprint(a.definition)) {
            try { await syncSchedules(a.id, def); }
            catch (e) { log.warn(`[automation restore] schedule re-sync failed for ${a.id}: ${e.message}`); }
        }
    }
    res.json({ automation: projectForViewer(updated, access), restoredFromVersion: version.version, ...(answers ? { answers } : {}) });
});


// Per-field differences (5d's table) and milestone names. Five segments, so
// neither can collide with the routes above.
router.get('/:id/versions/:versionId/fielddiff/:other', readsNothing, history.diff);
router.put('/:id/versions/:versionId/name', validate({ query: NoQuery }), history.rename);

/**
 * Coarse structural diff between two automation definitions. Builds a
 * step-id → change-kind map so the UI can colour the diff viewer
 * without doing the JSON walk on the client. Phase 2 swaps this for a
 * proper jsondiffpatch payload — for now the summary covers ~90% of
 * what users want to see (added/removed/edited steps + edges).
 */
function summariseDefinitionDiff(defA, defB) {
    const stepsA = new Map();
    const stepsB = new Map();
    for (const s of (defA?.steps || [])) if (s?.id) stepsA.set(s.id, s);
    for (const s of (defB?.steps || [])) if (s?.id) stepsB.set(s.id, s);

    const added = [];
    const removed = [];
    const changed = [];
    for (const [id, sB] of stepsB) {
        const sA = stepsA.get(id);
        if (!sA) { added.push(id); continue; }
        if (JSON.stringify(sA) !== JSON.stringify(sB)) changed.push(id);
    }
    for (const id of stepsA.keys()) {
        if (!stepsB.has(id)) removed.push(id);
    }

    const edgesA = JSON.stringify(defA?.edges || []);
    const edgesB = JSON.stringify(defB?.edges || []);
    const triggerA = JSON.stringify(defA?.trigger || null);
    const triggerB = JSON.stringify(defB?.trigger || null);

    return {
        steps: { added, removed, changed },
        edgesChanged: edgesA !== edgesB,
        triggerChanged: triggerA !== triggerB,
    };
}

module.exports = router;
// A restore and a duplicate provision a form the same way (actions.js).
module.exports.provisionForm = provisionForm;

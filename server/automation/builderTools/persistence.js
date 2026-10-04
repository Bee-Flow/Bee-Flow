/**
 * Builder tools — draft persistence: the write-through to the automations
 * table (create on first mutation, update thereafter, finalize gate).
 * Required from within automation/builderTools/ and the ../builderTools
 * facade.
 */

const automationStore = require('../../stores/automationStore');
const { validateDefinition } = require('../validate');
const { getDeliverableEvents } = require('../deliverableEvents');
const { syncDatatableUsage } = require('../datatableUsageSync');
const { syncKbSources } = require('../../core/kb/kbSourceSync');
const log = require('../../telemetry/log');

/**
 * Persist the draft to the automations table. Creates a row on the first
 * call and updates thereafter. Setting `finalize:true` flips is_draft to
 * false (still inactive — user must Activate explicitly).
 */
async function persistDraft(draftWrap, { finalize = false } = {}) {
    const def = draftWrap.def;
    /**
     * De agentpoort, op het ENIGE opslagpad van de builder.
     *
     * `validateDefinition` is de pure pass en kan niet in de database kijken of
     * een agent bestaat, gepubliceerd is en met deze eigenaar gedeeld — dus
     * wordt de catalogus hier gebouwd en meegegeven, precies zoals de
     * assignee- en kennisbankpoorten hieronder.
     *
     * Zonder dit was `builder_replace_step` de enige route waarnaar
     * `builder_update_step` het model dóórstuurt ("so the permission check runs
     * on it") terwijl daar geen enkele controle stond: een agent-herkoppeling
     * passeerde elke save-time-controle, en de belofte in de toolbeschrijving
     * was juist de reden dat het model dat pad koos.
     *
     * Fail-open in zijn geheel (`null` ⇒ de regel wordt overgeslagen) — zie
     * automation/agentCatalog.js. De run blijft de echte poort.
     */
    let availableAgents = null;
    if (draftWrap.userId) {
        try {
            const { agentCatalogForOwner } = require('../agentCatalog');
            availableAgents = await agentCatalogForOwner(def, draftWrap.userId);
        } catch (e) {
            log.warn(`[builderTools] agent check skipped: ${e.message}`);
        }
    }
    const validation = validateDefinition(def, { deliverableEvents: getDeliverableEvents(), availableAgents });
    // Approval assignees must belong to the owner's org — the DB half of the
    // rule (shape lives in validate.js). Reported like any other validation
    // error so the model self-corrects instead of persisting a stranger.
    if (draftWrap.userId) {
        try {
            const assigneeErrors = await require('../approvalService').validateApprovalAssignees(def, draftWrap.userId);
            if (assigneeErrors.length) {
                validation.ok = false;
                validation.errors = [...(validation.errors || []), ...assigneeErrors.map(e => ({ code: 'approval.assignee_invalid', severity: 'error', ...e }))];
            }
        } catch (e) {
            log.warn(`[builderTools] assignee validation skipped: ${e.message}`);
        }
        /**
         * The knowledge-base gate, same shape as the assignee rule above and
         * for the same reason: `validateDefinition` is the pure pass and cannot
         * read `knowledge_bases`. Without this the AI and MCP builders were the
         * one authoring surface that could finalize an automation writing to a base
         * its owner may not touch — while `builder_add_knowledge_write`'s own
         * description promises the save refuses exactly that.
         *
         * Reported as a validation error so the model self-corrects and picks a
         * base it may use, rather than persisting one that is refused at run
         * time on every run.
         */
        try {
            const { kbStepFindings } = require('../../core/kb/automationKbCheck');
            const kbFindings = await kbStepFindings(def, {
                orgId: draftWrap.orgId || null,
                userId: draftWrap.userId,
                stage: finalize ? 'activate' : 'draft',
            });
            const blocking = kbFindings.filter(f => f.severity === 'error');
            if (blocking.length) {
                validation.ok = false;
                validation.errors = [...(validation.errors || []), ...blocking];
            }
        } catch (e) {
            log.warn(`[builderTools] knowledge-base check skipped: ${e.message}`);
        }
    }
    const triggerType = def.trigger?.kind || 'manual';
    const scheduleCron = def.trigger?.schedule?.cron || null;
    const scheduleTz = def.trigger?.schedule?.tz || 'Europe/Amsterdam';

    // Only flip is_draft:false when the definition actually validates —
    // finalize is a request, not a command. Without this gate, a caller
    // asking to finalize an invalid draft got is_draft permanently flipped
    // to false HERE, before the route's own post-hoc validation check ever
    // ran — and nothing ever reverted it on that later rejection.
    const canFinalize = finalize && validation.ok;

    if (!draftWrap.automationId) {
        // Resolve the org from the user record when the session didn't carry
        // it — a builder automation created with organization_id NULL bypasses
        // the org Privacy Shield at run time. Best-effort; keep null if the
        // user genuinely has no org.
        let orgId = draftWrap.orgId || null;
        if (!orgId && draftWrap.userId) {
            try {
                const userStore = require('../../stores/userStore');
                const u = await userStore.getUser(draftWrap.userId);
                orgId = u?.organizationId || null;
                if (orgId) draftWrap.orgId = orgId; // memoize for subsequent updates
            } catch (_) { /* keep null */ }
        }
        // Create a draft row.
        const a = await automationStore.createAutomation({
            userId: draftWrap.userId,
            organizationId: orgId,
            title: draftWrap.title || 'Untitled automation',
            description: draftWrap.description || '',
            definition: def,
            triggerType,
            scheduleCron,
            scheduleTz,
            createdFromChatId: draftWrap.builderSessionId,
        });
        draftWrap.automationId = a.id;
        // The builder writes datatable steps like any other author, and this is
        // the only save path it has — without this its automations never appear in
        // "used by", so the destructive-change guard cannot see them either.
        await syncDatatableUsage(a.id, orgId, def, { label: 'builderTools' });
        await syncKbSources(a.id, def, { userId: draftWrap.userId, title: a.title });
        if (canFinalize) {
            return automationStore.updateAutomation(a.id, { isDraft: false }, draftWrap.userId);
        }
        if (finalize && !validation.ok) a.validationErrors = validation.errors;
        return a;
    }
    // Update existing row. Snapshot the stored definition FIRST: when the
    // automation is ACTIVE the trigger config below has to be compared against
    // what its subscriptions and schedule rows were built from.
    let prior = null;
    try { prior = await automationStore.getAutomation(draftWrap.automationId); } catch (_) { /* treated as unchanged */ }
    const updates = {
        title: draftWrap.title || undefined,
        description: draftWrap.description || undefined,
        definition: def,
        triggerType,
        scheduleCron,
        scheduleTz,
    };
    if (canFinalize) updates.isDraft = false;
    const u = await automationStore.updateAutomation(draftWrap.automationId, updates, draftWrap.userId);
    await syncDatatableUsage(draftWrap.automationId, draftWrap.orgId || u?.organizationId || null, def,
        { label: 'builderTools' });
    await syncKbSources(draftWrap.automationId, def, { userId: draftWrap.userId, title: u?.title || draftWrap.title });
    if (!validation.ok) {
        // Persist anyway (it's a draft) but expose the errors to the caller.
        u.validationErrors = validation.errors;
    }
    await resyncLiveTriggers(draftWrap, prior, u, def);
    return u;
}

/**
 * The MCP builder edits an automation that may already be ACTIVE — and PUT /:id
 * is not on its path, so the re-sync that route does on save never ran here.
 * Result: an app_event trigger whose filter was just changed kept firing on
 * the OLD subscription row, and a new or changed secondary schedule never got
 * its automation_schedules row, until someone deactivated and re-activated.
 *
 * Same gates as the route (fingerprints, so a label edit never re-anchors a
 * poller cursor), same helpers, best-effort: a sync failure is logged and the
 * save stands — the definition is the source of truth and the next activate
 * repairs the rows.
 */
async function resyncLiveTriggers(draftWrap, prior, saved, def) {
    if (!saved?.isActive) return;
    // Handoff 5: an automation with a live version runs (and is triggered by) the
    // LIVE definition; this save changed only the working copy. Its triggers
    // are re-registered when it is published (routes/automation/activate.js).
    if (saved.liveVersion != null) return;
    const priorDef = prior?.definition || null;
    const { syncAppEventSubscription, hasAppEventTrigger, appEventFingerprint } = require('../subscriptionSync');
    const { syncSchedules, scheduleFingerprint } = require('../scheduleSync');
    if ((hasAppEventTrigger(def) || hasAppEventTrigger(priorDef))
        && appEventFingerprint(def) !== appEventFingerprint(priorDef)) {
        try { await syncAppEventSubscription(draftWrap.automationId, draftWrap.userId || saved.userId, def); }
        catch (e) { log.warn(`[builderTools] subscription re-sync failed for ${draftWrap.automationId}: ${e.message}`); }
    }
    if (scheduleFingerprint(def) !== scheduleFingerprint(priorDef)) {
        try { await syncSchedules(draftWrap.automationId, def); }
        catch (e) { log.warn(`[builderTools] schedule re-sync failed for ${draftWrap.automationId}: ${e.message}`); }
    }
}

module.exports = {
    persistDraft,
};

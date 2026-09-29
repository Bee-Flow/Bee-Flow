/**
 * POST /automations/:id/activate — the checks a routine must pass before it
 * runs unattended, and the wiring that makes it run.
 *
 * Moved verbatim out of routes/automation/crud.js, which keeps the route
 * registration. HTTP-shaped on purpose: every refusal in here is a status
 * code with a message the builder renders, and the gate reads req.session.
 *
 * `agentsFor`, `kbFindingsFor` and `wakeComplianceReview` are injected rather
 * than imported: they stay in crud.js because the save and import paths use
 * the same three, and a routine must never be able to resolve an agent
 * catalog or an organisation differently depending on which route asked.
 */

const automationStore = require('../../stores/automationStore');
const log = require('../../telemetry/log');
const { nextScheduledRunAt, scheduleSkipsHolidays } = require('../../automation/holidays');
const { validateDefinition } = require('../../automation/validate');
const { topicClassifierFor } = require('../../core/classify/classifierClient');
const { summariseDefinition } = require('../../automation/summarise');
const { getDeliverableEvents } = require('../../automation/deliverableEvents');
const { TOOL_REGISTRY, loadTools } = require('../../automation/toolRegistry');
const { syncSchedules } = require('../../automation/scheduleSync');
const { syncAppEventSubscription } = require('../../automation/subscriptionSync');
const { collectPinnedNodes } = require('../../automation/portability');
const { definitionForRun } = require('../../core/automationRunner/definitionForRun');
const { resolveRunPolicy, runTimeoutMsFor } = require('../../core/automationRunner/runPolicy');
const { triggerColumnsFromDefinition } = require('../../automation/triggerColumns');
const { appEventFingerprint, hasAppEventTrigger } = require('../../automation/subscriptionSync');
const { scheduleFingerprint } = require('../../automation/scheduleSync');
const { projectForViewer } = require('../../automation/access');
const { HttpError } = require('../../core/http/errors');
const { gateRefusal } = require('../../automation/aiActCheck');

/**
 * The checks a DEFINITION must pass before it runs unattended — shared by
 * activate and publish (handoff 5), so "Make vN live" is exactly as strict as
 * "Activate" and neither can let through what the other refuses.
 *
 * Answers `{ ok: true, warnings }` or `{ ok: false, status, body }`; the
 * caller writes the response. The AI Act gate is the one refusal that THROWS
 * (HttpError 409 `ai_act_check_required` / `ai_act_prohibited`, with
 * `details.aiAct`); the terminal error handler answers it. `definition` is the copy that is about to run:
 * the working copy for a publish (and for activating a never-live routine),
 * the live copy for re-activating a paused routine that has one.
 */
async function checkBeforeLive(req, a, definition, { agentsFor, kbFindingsFor, permittedApps = null, aiActState = null }) {
    // The OWNER's catalog: steps run as them (handoff 5 sharing), so an editor
    // pressing Activate is checked against what the owner may use. The
    // presser's session only stands in when the presser IS the owner.
    const userId = a?.userId || req.session.user.id;
    const ownSession = userId === req.session.user.id ? req.session : null;
    const def = definition || {};

    // Build the user's permitted-tool catalog so activation rejects unknown
    // tools (typos, unpermitted integrations) and missing/empty required
    // inputs — instead of letting a broken routine go live and fail silently
    // on first fire. Permission-based (matches the builder palette, not
    // credential-gated); fail-open if the lookup errors.
    let availableTools = null;
    let toolRequiredParams = null;
    try {
        const getUserPermittedApps = permittedApps || require('../../core/integrations/integrationTools').getUserPermittedApps;
        const permitted = await getUserPermittedApps({ userId, session: ownSession, isAdmin: !!ownSession?.isAdmin });
        availableTools = new Set();
        toolRequiredParams = {};
        for (const entry of TOOL_REGISTRY) {
            const permittedApp = permitted.has(entry.app);
            for (const t of loadTools(entry)) {
                const name = t?.function?.name;
                if (!name) continue;
                if (permittedApp) availableTools.add(name);
                const rq = t?.function?.parameters?.required;
                if (Array.isArray(rq)) toolRequiredParams[name] = rq;
            }
        }
    } catch (e) {
        log.warn('[automation/activate] tool catalog build failed; activating without tool checks:', e.message);
        availableTools = null; toolRequiredParams = null;
    }
    // Deliverability = poller-backed NC events only (the SaaS poll tick fires
    // these with no connector dependency). Push-only events (Deck/Talk/share/
    // calendar mutations) need the Bee Flow ExApp connector push pipeline,
    // which is pending live validation — so they get a NON-BLOCKING warning
    // ("requires Bee Flow ExApp connector — pending validation"). This is a
    // UI honesty signal only; it does not change subscription delivery.
    const deliverableEvents = getDeliverableEvents();
    // http_request saved-credential check (Feature C): the set of HTTP
    // connection ids the owner can use (own + lent). Warning-level in
    // validateDefinition, fail-open, and only built when the definition
    // actually references step.auth — no store round-trip otherwise.
    // Availability is enforced structurally by the store's own-or-grant
    // SQL; this is a UX honesty signal at activation time.
    let knownConnectionIds = null;
    if (JSON.stringify(def).includes('"connectionId"')) {
        try {
            const userStore = require('../../stores/userStore');
            const connStore = require('../../stores/integrationConnectionStore');
            const owner = await userStore.getUser(userId).catch(() => null);
            const accessible = await connStore.listAccessibleConnections({
                userId,
                orgId: connStore.resolveOrgId(owner?.organizationId),
                groups: Array.isArray(owner?.groups) ? owner.groups : [],
                provider: 'http',
            });
            knownConnectionIds = new Set(accessible.map(c => c.id));
        } catch (e) {
            log.warn('[automation/activate] http credential catalog build failed; activating without credential checks:', e.message);
            knownConnectionIds = null;
        }
    }
    // R2 — the agents this routine's ai_steps hand their thinking to.
    // `validateDefinition` is the pure pass and cannot ask the database
    // whether an agent exists, sits in this organisation and is published,
    // so the catalog is built here and injected, exactly like
    // availableTools. Asked of the ROUTINE OWNER (`a.userId`), because the
    // run happens as them and not as whoever pressed Activate.
    //
    // The identity is resolved in ONE place (agentCatalogForOwner) rather
    // than here: this route used to read the routine's stored
    // `organizationId` with the presser's org as a fallback, while the run
    // measures the OWNER's current membership. For a routine saved without
    // an organisation those two disagree, and the disagreement is invisible
    // — the screen and the activation both say yes, and every scheduled run
    // says `agent_unavailable`.
    //
    // Fail-open on its own failure (agentCatalogForOwner returns null and
    // the rule is skipped), for the reason kbFindingsFor gives: a lookup
    // outage must not make every routine unactivatable, and this is not the
    // gate.
    // The gate is at run time — resolveStepAgent in
    // core/automationRunner/aiStepAgent.js FAILS the step when the agent it
    // names cannot be used, rather than running the step without it, which
    // is what makes an agent deleted or unpublished AFTER activation
    // visible instead of silent.
    const availableAgents = await agentsFor(def, a.userId || req.session.user.id);
    // "Is about" rules need the topic classifier; `false` (none configured)
    // blocks activation, an unknown state never does (topicRules.js).
    const topicClassifier = await topicClassifierFor(def);
    const v = validateDefinition(def, { availableTools, toolRequiredParams, deliverableEvents, knownConnectionIds, availableAgents, topicClassifier });
    if (!v.ok) return { ok: false, status: 400, body: { error: 'Invalid definition', details: v.errors } };

    // Knowledge-base links, checked against the database (validate.js is
    // the pure pass and cannot). This is where a bad link stops being the
    // author's private business: from here the routine runs unattended, on
    // a schedule, with nobody reading the output — and the runtime drops an
    // id it cannot authorise, so activating anyway would mean running with
    // less knowledge than the author configured and no sign of it.
    // `a.userId` — rowToAutomation camel-cases it, so the old `a.user_id`
    // was always undefined and the fallback was the only branch that ever
    // ran. The code read "check the OWNER" while it always checked whoever
    // pressed Activate, which are different people the moment a routine is
    // shared.
    const kbErrors = await kbFindingsFor(def, req, a.userId || req.session.user.id, 'activate');
    if (kbErrors.length) return { ok: false, status: 400, body: { error: 'Invalid definition', details: kbErrors } };

    // ── Pinned sample data (BFSF-408/409/434) ────────────────────────────
    //
    // A pinned node SERVES saved data instead of running — that is the
    // point of a pin while you build, and it is a trap the moment the
    // routine is live: the step never calls the thing it names, and the
    // run is reported green. Activation is where that stops being the
    // author's private business, so it says so here. Nothing else in the
    // pipeline does: validateDefinition checks a pin's shape and size, not
    // whether serving one is what you meant.
    //
    // The two cases are treated differently on purpose.
    //
    //   captured — a snapshot of a real run of that node. Whatever it
    //     serves, the node really did produce once. A WARNING: the author
    //     may well have pinned an expensive upstream step deliberately.
    //
    //   edited — typed or altered by hand. It never came out of anything,
    //     so a live run would hand invented data to real side effects —
    //     an email to a made-up address, an invoice for a made-up amount.
    //     A 400, because there is no reading of "activate" under which
    //     that is what was asked for. Unpin it, or capture it for real.
    const pins = collectPinnedNodes(def);
    const pinLabel = (pin) => `${pin.kind === 'trigger' ? 'Trigger' : 'Step'} "${pin.id || '(no id)'}"${pin.layerKey ? ` in flowlet "${pin.layerKey}"` : ''}`;
    const pinPath = (pin) => `${pin.layerKey ? `layers.${pin.layerKey}.` : ''}${pin.kind === 'trigger' ? 'trigger' : `steps[${pin.id}]`}`;
    const editedPins = pins.filter(pin => pin.pinnedSource === 'edited');
    if (editedPins.length) {
        return { ok: false, status: 400, body: {
            error: `Cannot activate — ${editedPins.map(pinLabel).join(', ')} serve${editedPins.length === 1 ? 's' : ''} sample data you wrote by hand instead of running. A live run would use that made-up data for real. Unpin, or capture a sample from a real run.`,
            code: 'pinned_edited_sample',
            details: editedPins.map(pin => ({
                code: 'pin.edited_sample_blocks_activation', severity: 'error', path: pinPath(pin),
                message: `${pinLabel(pin)} serves hand-written sample data instead of running.`,
                hint: 'Open the node and unpin it, or run the step once and pin its real output.',
            })),
        } };
    }

    // Warnings are non-blocking but reported to the client.
    const pinWarnings = pins.map(pin => ({
        code: 'pin.serves_sample_data', severity: 'warning', path: pinPath(pin),
        message: `${pinLabel(pin)} serves pinned data instead of running — live runs will use that saved sample, not fresh data.`,
        hint: 'Unpin it if the routine should do this work for real; keep it if serving the sample is deliberate.',
    }));
    // ── AI Act check (handoff 5, owner decision 2) ──────────────────────
    //
    // Only in an organisation with the compliance hub licence
    // (`compliance_hub_gdpr`): there a routine goes live only with a valid,
    // unexpired check (automation/aiActCheck.js). Last, so the author sees
    // what is wrong with the steps first. `aiActState` is injected by the
    // route (crud.js); a caller without it is not gated. crud.js injects the
    // automatic check (automation/aiActAuto.js gateState): Bee records what
    // it can answer itself here, and a refusal carries only the questions it
    // could not (`details.questions`).
    if (typeof aiActState === 'function') {
        const refusal = gateRefusal(await aiActState(a, def));
        if (refusal) throw new HttpError(refusal.status, refusal.code, refusal.message, refusal.details);
    }

    summariseDefinition(def);
    return { ok: true, warnings: [...(v.warnings || []), ...pinWarnings] };
}

/**
 * The caller's access for activate/publish: `edit` or more (handoff 5
 * sharing). `deps.access` is automation/access.js's guard; without it (a
 * direct handler test) the owner alone. Answers null after writing the 403.
 */
async function editAccess(req, res, a, deps) {
    if (deps.access) return deps.access.guard(req, res, a, 'edit');
    if (a.userId === req.session.user.id) return { role: 'owner', via: 'owner' };
    res.status(403).json({ error: 'Forbidden' });
    return null;
}

/** The automation as the caller may see it, with their role on it. */
function forViewer(automation, access) {
    if (!automation) return automation;
    return projectForViewer(automation, access);
}

/**
 * POST /:id/activate — switch a routine on.
 *
 * Never live yet: the working copy is checked, becomes the live version
 * (the store publishes it in the same write that sets is_active — see
 * stores/automationStore/lifecycle.js LIVE_INVARIANT_SQL) and its triggers
 * are registered. Today's semantics.
 *
 * Already has a live version (a paused routine): only switches it back on.
 * Pending changes in the working copy stay pending — going live with them is
 * POST /:id/publish. The LIVE copy is what gets checked, because it is what
 * will run.
 */
async function activateAutomation(req, res, deps) {
    const { wakeComplianceReview } = deps;
    const store = deps.store || automationStore;
    const syncSubs = deps.syncAppEventSubscription || syncAppEventSubscription;
    const syncScheds = deps.syncSchedules || syncSchedules;
    const userId = req.session.user.id;
    const a = await store.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await editAccess(req, res, a, deps);
    if (!access) return;
    // Subscriptions and the Gmail catch-up use the OWNER's connected account.
    const ownerId = a.userId || userId;

    const neverLive = a.liveVersion == null;
    const def = neverLive ? (a.definition || {}) : definitionForRun(a, { mode: 'live' }).definition;
    const verdict = await checkBeforeLive(req, a, def, deps);
    if (!verdict.ok) return res.status(verdict.status).json(verdict.body);

    const updates = {
        isActive: true,
        isDraft: false,
        // First-run confirmation gate removed — activation runs live
        // immediately. The dry-run during build still gives the user a
        // preview before they activate.
        needsFirstRunConfirm: false,
    };
    if (a.triggerType === 'schedule' && a.scheduleCron) {
        // A bad stored cron is a client-fixable problem — return 400 with a
        // clear message instead of letting cron.nextRunAt throw into the
        // catch-all 500. A structurally-unreachable cron (null) is also a
        // 400: activating it would never fire.
        let next;
        // schedule.skipHolidays (handoff 5): the first slot already steps over holidays.
        try { next = nextScheduledRunAt(a.scheduleCron, a.scheduleTz || 'Europe/Amsterdam', Date.now(), { skipHolidays: scheduleSkipsHolidays(def) }); }
        catch (e) { return res.status(400).json({ error: `Cannot activate — invalid schedule "${a.scheduleCron}": ${e.message}` }); }
        if (!next) return res.status(400).json({ error: `Cannot activate — schedule "${a.scheduleCron}" has no upcoming run time. Check the day/month combination.` });
        updates.nextRunAt = next;
    }
    // runPolicy.maxDurationMin also sets run_timeout_ms, which the stuck-run
    // reaper reads for its window. Only when the definition carries a policy.
    if (def.runPolicy && typeof def.runPolicy === 'object') {
        updates.runTimeoutMs = runTimeoutMsFor(resolveRunPolicy(def));
    }
    // Never live: the working copy that was just CHECKED goes live, exactly,
    // like publish. A save landing between the checks and this write would
    // otherwise go live unchecked through the store's active⇒live rule; here
    // it answers 409 version_changed instead. (A store without the call, a
    // handler test's double, keeps the plain write.)
    let u;
    if (neverLive && (a.kind || 'automation') === 'automation' && typeof store.publishWorkingCopy === 'function') {
        u = await store.publishWorkingCopy(a.id, { expectedVersion: a.version, columns: updates });
        if (!u) {
            return res.status(409).json({
                error: 'The routine changed while it was being checked. Review it and activate again.',
                code: 'version_changed',
            });
        }
    } else {
        u = await store.updateAutomation(a.id, updates, userId);
    }

    // App-event triggers need a row in automation_event_subscriptions
    // before the poller / inbound-event handler will see them. Without
    // this the LLM happily declares `kind:'app_event',appProvider:'gmail'`
    // but no email ever fires the automation. Done idempotently — we
    // delete-then-create so re-activating after a definition change
    // refreshes the filter / cursor.
    // From the copy that will RUN: the live one for a paused routine.
    await syncSubs(a.id, ownerId, def);
    // Additional schedule triggers get their automation_schedules rows —
    // re-armed, so a routine re-activated after a pause fires at its NEXT
    // slot rather than catching up on the first tick.
    await syncScheds(a.id, def, { rearm: true });

    // Immediate Gmail check on activate: if a trigger (primary or one of
    // definition.triggers[]) is mail.new, pull the most recent matching
    // email and dispatch it once TO THAT TRIGGER'S OWN SUBSCRIPTION. The
    // old per-trigger loop called the BROAD dispatchEvent, which fans out
    // to every gmail/mail.new subscription of the user — N triggers on
    // this automation produced N² catchup runs of the same email, plus a
    // spurious run of every UNRELATED active gmail routine (A13).
    // dispatchToSubscription applies the sub's own filter and seeds the
    // run from its triggerStepId. Run async so the HTTP response stays
    // snappy.
    (async () => {
        try {
            const dispatch = require('../../automation/triggerBus/dispatch');
            const triggerBus = require('../../automation/triggerBus');
            const subs = await store.getSubscriptionsForAutomation(a.id);
            const gmailSubs = (subs || []).filter(s => s.provider === 'gmail' && s.eventType === 'mail.new');
            for (const sub of gmailSubs) {
                try {
                    // sub.filter is the normalized copy of the trigger's
                    // filter — use it for the fetch so fetch and dispatch
                    // agree on what "matching" means.
                    const latest = await triggerBus.fetchLatestGmailMatch(ownerId, sub.filter || null);
                    if (latest) {
                        dispatch.dispatchToSubscription(sub, { provider: 'gmail', event: 'mail.new', payload: latest });
                    }
                } catch (e) {
                    log.warn(`[automation/activate] immediate Gmail dispatch failed for ${a.id} sub ${sub.id}: ${e.message}`);
                }
            }
        } catch (e) {
            log.warn(`[automation/activate] immediate Gmail catchup failed for ${a.id}: ${e.message}`);
        }
    })();

    // The routine is live from this line on — so is whatever it does with
    // personal data. Compliance hears about it now rather than at the next
    // 6-hourly sweep. Never awaited, never able to fail this request.
    wakeComplianceReview(a, 'activation');

    res.json({ automation: forViewer(u, access), warnings: verdict.warnings });
}

/**
 * POST /:id/publish — "Make vN live": the working copy becomes the live
 * version (handoff 5).
 *
 * Exactly as strict as activation (checkBeforeLive). Body `{ version? }`: the
 * version the person is looking at; when given and it is no longer the
 * working version (a save landed in between) the answer is 409
 * `version_changed` instead of publishing something they did not see. The
 * copy is also exact at the database: the store only publishes the version
 * this handler checked.
 *
 * The trigger-derived columns (trigger_type, schedule_cron/tz, next_run_at,
 * run_timeout_ms) move with the live copy, in the same statement. On an
 * ACTIVE routine the triggers are re-registered from the new live definition
 * — each only when its configuration changed, so publishing a label edit on
 * a Gmail routine does not re-anchor its poller cursor. A paused routine
 * stays paused; a never-live one becomes live without being switched on.
 */
async function publishAutomation(req, res, deps) {
    const { wakeComplianceReview, ensureFormPages } = deps;
    const store = deps.store || automationStore;
    const syncSubs = deps.syncAppEventSubscription || syncAppEventSubscription;
    const syncScheds = deps.syncSchedules || syncSchedules;
    const a = await store.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await editAccess(req, res, a, deps);
    if (!access) return;
    const ownerId = a.userId || req.session.user.id;

    const asked = req.body?.version;
    if (asked !== undefined && asked !== null && asked !== a.version) {
        return res.status(409).json({
            error: `Version ${asked} is no longer the latest; the routine is at version ${a.version} now. Review it and publish again.`,
            code: 'version_changed', version: a.version,
        });
    }

    const def = a.definition || {};
    const verdict = await checkBeforeLive(req, a, def, deps);
    if (!verdict.ok) return res.status(verdict.status).json(verdict.body);

    const cols = triggerColumnsFromDefinition(def);
    const columns = { ...cols, nextRunAt: null };
    if (cols.triggerType === 'schedule' && cols.scheduleCron) {
        let next;
        try { next = nextScheduledRunAt(cols.scheduleCron, cols.scheduleTz || 'Europe/Amsterdam', Date.now(), { skipHolidays: scheduleSkipsHolidays(def) }); }
        catch (e) { return res.status(400).json({ error: `Cannot publish: the schedule "${cols.scheduleCron}" is not valid (${e.message}).`, code: 'invalid_schedule' }); }
        if (!next) return res.status(400).json({ error: `Cannot publish: the schedule "${cols.scheduleCron}" has no upcoming run time. Check the day and month combination.`, code: 'invalid_schedule' });
        // Only an active routine is armed; a paused one is re-armed by activate.
        columns.nextRunAt = a.isActive ? next : null;
    }
    if (def.runPolicy && typeof def.runPolicy === 'object') {
        columns.runTimeoutMs = runTimeoutMsFor(resolveRunPolicy(def));
    }
    // A routine that goes live stops being a draft, whether or not it runs.
    columns.isDraft = false;

    const previousLive = a.liveVersion == null ? null : definitionForRun(a, { mode: 'live' }).definition;
    const u = await store.publishWorkingCopy(a.id, { expectedVersion: a.version, columns });
    if (!u) {
        return res.status(409).json({
            error: 'The routine changed while it was being checked. Review it and publish again.',
            code: 'version_changed',
        });
    }

    if (u.isActive) {
        if ((hasAppEventTrigger(def) || hasAppEventTrigger(previousLive))
            && (previousLive == null || appEventFingerprint(def) !== appEventFingerprint(previousLive))) {
            try { await syncSubs(a.id, ownerId, def); }
            catch (e) { log.warn(`[automation/publish] subscription re-sync failed for ${a.id}: ${e.message}`); }
        }
        if (previousLive == null || scheduleFingerprint(def) !== scheduleFingerprint(previousLive)) {
            try { await syncScheds(a.id, def); }
            catch (e) { log.warn(`[automation/publish] schedule re-sync failed for ${a.id}: ${e.message}`); }
        }
    }
    if (typeof ensureFormPages === 'function') await ensureFormPages(a.id, def);

    wakeComplianceReview(a, 'publish');
    res.json({ automation: forViewer(u, access), warnings: verdict.warnings });
}

module.exports = { activateAutomation, publishAutomation, checkBeforeLive };

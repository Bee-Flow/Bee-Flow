/**
 * Going live, without HTTP: the decisions and side effects behind POST
 * /automations/:id/activate, /publish and /deactivate, moved out of
 * routes/automation/activate.js and routes/automation/crud.js so that code
 * below routes/ (the Solution deploy engine) switches an automation on, off and
 * live through the SAME gates the routes run. The routes keep the access
 * check and the response; everything else is here.
 *
 *   planGoLive              the columns that move with the live copy
 *   checkBeforeLiveCore     the checks a definition passes before it runs unattended
 *   activateCore            switch on (publishing a never-live working copy)
 *   deactivateCore          switch off
 *   convergeAfterPublish    the idempotent side effects after a publish
 *
 * A refusal is a value, never an exception: `{ ok: false, status, code,
 * message, body }`, where `body` is exactly what the route answers. The AI Act
 * gate is the one refusal the routes answer by THROWING (the terminal handler
 * renders it); it comes back with `raise: true` and `details`, and
 * `refusalError` turns it into that HttpError.
 *
 * Every dependency is injectable through `deps`; the defaults are required
 * lazily, so a route test that swaps a module through require.cache still
 * reaches the real call path.
 */

'use strict';

const log = require('../telemetry/log');
const { HttpError } = require('../core/http/errors');

const DEFAULT_TZ = 'Europe/Amsterdam';

/** A refusal in the one shape every core answers. */
function refuse(status, code, message, body) {
    return { ok: false, status, code: code || null, message, body: body || { error: message, ...(code ? { code } : {}) } };
}

/** The HttpError a `raise: true` refusal stands for. */
function refusalError(r) {
    return new HttpError(r.status, r.code, r.message, r.details);
}

const SCHEDULE_MESSAGES = {
    publish: {
        invalid: (cron, why) => `Cannot publish: the schedule "${cron}" is not valid (${why}).`,
        unreachable: (cron) => `Cannot publish: the schedule "${cron}" has no upcoming run time. Check the day and month combination.`,
    },
    activate: {
        invalid: (cron, why) => `Cannot activate — invalid schedule "${cron}": ${why}`,
        unreachable: (cron) => `Cannot activate — schedule "${cron}" has no upcoming run time. Check the day/month combination.`,
    },
};

/**
 * The columns that go live with a definition.
 *
 * `verb: 'publish'` (the default): the trigger-derived columns (trigger_type,
 * schedule_cron/tz) come from the DEFINITION and move with the live copy, in
 * the same statement; next_run_at is cleared unless the schedule is armed.
 *
 * `verb: 'activate'`: switching an existing automation on reads the schedule from
 * the ROW's columns (they already belong to the copy that will run) and writes
 * no trigger columns; next_run_at is only touched for a schedule.
 *
 * Either way a bad or unreachable cron is a client-fixable 400
 * `invalid_schedule` (the messages are the routes' own, per verb), the schedule
 * is armed (nextRunAt) only when the automation is or will be active, a
 * runPolicy sets run_timeout_ms (the stuck-run reaper's window), and the
 * automation stops being a draft.
 *
 * @returns {{ok: true, columns: object}|{ok: false, status, code, message, body}}
 */
function planGoLive(automation, definition, { now = Date.now(), willBeActive, verb = 'publish', deps = {} } = {}) {
    const { nextScheduledRunAt, scheduleSkipsHolidays } = deps.holidays || require('./holidays');
    const { resolveRunPolicy, runTimeoutMsFor } = deps.runPolicy || require('../core/automationRunner/runPolicy');
    const a = automation || {};
    const def = definition || {};
    const active = willBeActive === undefined ? !!a.isActive : !!willBeActive;
    const messages = SCHEDULE_MESSAGES[verb] || SCHEDULE_MESSAGES.publish;

    const columns = {};
    let cron = null;
    let tz = null;
    if (verb === 'activate') {
        if (a.triggerType === 'schedule' && a.scheduleCron) { cron = a.scheduleCron; tz = a.scheduleTz; }
    } else {
        const { triggerColumnsFromDefinition } = deps.triggerColumns || require('./triggerColumns');
        const cols = triggerColumnsFromDefinition(def);
        Object.assign(columns, cols, { nextRunAt: null });
        if (cols.triggerType === 'schedule' && cols.scheduleCron) { cron = cols.scheduleCron; tz = cols.scheduleTz; }
    }

    if (cron) {
        let next;
        // schedule.skipHolidays (handoff 5): the first slot already steps over holidays.
        try { next = nextScheduledRunAt(cron, tz || DEFAULT_TZ, now, { skipHolidays: scheduleSkipsHolidays(def) }); }
        catch (e) {
            const message = messages.invalid(cron, e.message);
            // The activate route has always answered this without a code.
            return refuse(400, 'invalid_schedule', message, verb === 'activate' ? { error: message } : undefined);
        }
        if (!next) {
            const message = messages.unreachable(cron);
            return refuse(400, 'invalid_schedule', message, verb === 'activate' ? { error: message } : undefined);
        }
        // Only an active automation is armed; a paused one is re-armed by activate.
        if (active) columns.nextRunAt = next;
    }
    if (def.runPolicy && typeof def.runPolicy === 'object') {
        columns.runTimeoutMs = runTimeoutMsFor(resolveRunPolicy(def));
    }
    // An automation that goes live stops being a draft, whether or not it runs.
    columns.isDraft = false;
    return { ok: true, columns };
}

/**
 * The owner's permitted-tool catalog: which tool names exist for them, and
 * which inputs each requires. Permission-based (matches the builder palette,
 * not credential-gated); fail-open — `null`s — when the lookup errors.
 */
async function toolCatalogFor(ownerId, ownSession, deps) {
    try {
        const { TOOL_REGISTRY, loadTools } = deps.toolRegistry || require('./toolRegistry');
        const getUserPermittedApps = deps.permittedApps || require('../core/integrations/integrationTools').getUserPermittedApps;
        const permitted = await getUserPermittedApps({ userId: ownerId, session: ownSession, isAdmin: !!ownSession?.isAdmin });
        const availableTools = new Set();
        const toolRequiredParams = {};
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
        return { availableTools, toolRequiredParams };
    } catch (e) {
        log.warn('[automation/activate] tool catalog build failed; activating without tool checks:', e.message);
        return { availableTools: null, toolRequiredParams: null };
    }
}

/**
 * The HTTP connection ids the owner can use (own + lent), for the
 * http_request saved-credential check — warning-level in validateDefinition,
 * fail-open, and only built when the definition references a connection.
 */
async function knownConnectionsFor(def, ownerId, deps) {
    if (!JSON.stringify(def).includes('"connectionId"')) return null;
    try {
        const userStore = deps.userStore || require('../stores/userStore');
        const connStore = deps.connectionStore || require('../stores/integrationConnectionStore');
        const owner = await userStore.getUser(ownerId).catch(() => null);
        const accessible = await connStore.listAccessibleConnections({
            userId: ownerId,
            orgId: connStore.resolveOrgId(owner?.organizationId),
            groups: Array.isArray(owner?.groups) ? owner.groups : [],
            provider: 'http',
        });
        return new Set(accessible.map(c => c.id));
    } catch (e) {
        log.warn('[automation/activate] http credential catalog build failed; activating without credential checks:', e.message);
        return null;
    }
}

const pinLabel = (pin) => `${pin.kind === 'trigger' ? 'Trigger' : 'Step'} "${pin.id || '(no id)'}"${pin.layerKey ? ` in flowlet "${pin.layerKey}"` : ''}`;
const pinPath = (pin) => `${pin.layerKey ? `layers.${pin.layerKey}.` : ''}${pin.kind === 'trigger' ? 'trigger' : `steps[${pin.id}]`}`;

/**
 * The checks a DEFINITION must pass before it runs unattended — shared by
 * activate and publish (handoff 5), so "Make vN live" is exactly as strict as
 * "Activate", and by the deploy engine, so a deployed automation is too.
 *
 * Asked of the automation OWNER (`ownerId`): steps run as them, so whoever
 * presses the button is checked against what the owner may use. `session` is
 * the presser's; it only stands in for the owner's when the presser IS the
 * owner. `organizationId` scopes the knowledge-base findings (default: the
 * automation's own `organizationId`).
 *
 * deps: `agentsFor(def, ownerId)`, `kbFindingsFor(def, {orgId, userId, stage})`
 * (both default to automation/liveSideEffects), `permittedApps`, `aiActState`
 * (the AI Act gate; a caller without it is not gated), and the validator's
 * collaborators for tests.
 *
 * @returns {Promise<{ok: true, warnings: object[]}|{ok: false, status, code, message, body}|{ok: false, raise: true, status, code, message, details}>}
 */
async function checkBeforeLiveCore({ automation, definition, ownerId, organizationId = null, session = null, deps = {} }) {
    const a = automation || {};
    const def = definition || {};
    const owner = ownerId || a.userId;
    const ownSession = session && session.user && session.user.id === owner ? session : null;
    const sideEffects = require('./liveSideEffects');
    const agentsFor = deps.agentsFor || sideEffects.agentsFor;
    const kbFindingsFor = deps.kbFindingsFor || sideEffects.kbFindingsFor;
    const { validateDefinition } = deps.validate || require('./validate');
    const { getDeliverableEvents } = deps.deliverableEvents || require('./deliverableEvents');
    const topicClassifierFor = deps.topicClassifierFor || require('../core/classify/classifierClient').topicClassifierFor;
    const { collectPinnedNodes } = deps.portability || require('./portability');
    const { summariseDefinition } = deps.summarise || require('./summarise');
    const { gateRefusal } = deps.aiActCheck || require('./aiActCheck');

    // Unknown tools (typos, unpermitted integrations) and missing required
    // inputs are refused here instead of failing silently on first fire.
    const { availableTools, toolRequiredParams } = await toolCatalogFor(owner, ownSession, deps);
    // Deliverability = poller-backed NC events only; push-only events get a
    // NON-BLOCKING warning (a UI honesty signal; delivery is unchanged).
    const deliverableEvents = getDeliverableEvents();
    const knownConnectionIds = await knownConnectionsFor(def, owner, deps);
    // R2 — the agents this automation's ai_steps hand their thinking to, from
    // the ONE identity resolver (agentCatalogForOwner). Fail-open: null skips
    // the rule; the run is the gate (core/automationRunner/aiStepAgent.js).
    const availableAgents = await agentsFor(def, owner);
    // "Is about" rules need the topic classifier; `false` (none configured)
    // blocks activation, an unknown state never does (topicRules.js).
    const topicClassifier = await topicClassifierFor(def);
    const v = validateDefinition(def, { availableTools, toolRequiredParams, deliverableEvents, knownConnectionIds, availableAgents, topicClassifier });
    if (!v.ok) return refuse(400, 'invalid_definition', 'Invalid definition', { error: 'Invalid definition', details: v.errors });

    // Knowledge-base links, checked against the database (validate.js is the
    // pure pass and cannot). From here the automation runs unattended, and the
    // runtime drops an id it cannot authorise — so a bad link is refused now.
    // The automation's own organisation when the caller has none to give (the
    // deploy engine): without it no KB counts as same-org (automationKbCheck).
    const orgId = organizationId || a.organizationId || null;
    const kbErrors = await kbFindingsFor(def, { orgId, userId: owner, stage: 'activate' });
    if (kbErrors.length) return refuse(400, 'invalid_definition', 'Invalid definition', { error: 'Invalid definition', details: kbErrors });

    // ── Pinned sample data (BFSF-408/409/434) ──
    // A pinned node SERVES saved data instead of running. A `captured` pin is
    // a snapshot of a real run: a warning. An `edited` pin never came out of
    // anything, so a live run would hand invented data to real side effects:
    // a 400. Unpin it, or capture it for real.
    const pins = collectPinnedNodes(def);
    const editedPins = pins.filter(pin => pin.pinnedSource === 'edited');
    if (editedPins.length) {
        const message = `Cannot activate — ${editedPins.map(pinLabel).join(', ')} serve${editedPins.length === 1 ? 's' : ''} sample data you wrote by hand instead of running. A live run would use that made-up data for real. Unpin, or capture a sample from a real run.`;
        return refuse(400, 'pinned_edited_sample', message, {
            error: message,
            code: 'pinned_edited_sample',
            details: editedPins.map(pin => ({
                code: 'pin.edited_sample_blocks_activation', severity: 'error', path: pinPath(pin),
                message: `${pinLabel(pin)} serves hand-written sample data instead of running.`,
                hint: 'Open the node and unpin it, or run the step once and pin its real output.',
            })),
        });
    }
    const pinWarnings = pins.map(pin => ({
        code: 'pin.serves_sample_data', severity: 'warning', path: pinPath(pin),
        message: `${pinLabel(pin)} serves pinned data instead of running — live runs will use that saved sample, not fresh data.`,
        hint: 'Unpin it if the automation should do this work for real; keep it if serving the sample is deliberate.',
    }));

    // ── AI Act check (handoff 5, owner decision 2) ──
    // Only in an organisation with the compliance hub licence; last, so the
    // author sees what is wrong with the steps first.
    if (typeof deps.aiActState === 'function') {
        const refusal = gateRefusal(await deps.aiActState(a, def));
        if (refusal) {
            return { ok: false, raise: true, status: refusal.status, code: refusal.code, message: refusal.message, details: refusal.details, body: null };
        }
    }

    summariseDefinition(def);
    return { ok: true, warnings: [...(v.warnings || []), ...pinWarnings] };
}

/**
 * Immediate Gmail check after an activation: for every gmail/mail.new
 * subscription of THIS automation, pull the most recent matching email and
 * dispatch it once to that subscription (never the broad dispatchEvent, which
 * fanned out to every gmail automation of the user — A13). Fire-and-forget: the
 * caller never waits for it and it never throws.
 */
function gmailCatchUp(store, automationId, ownerId, deps = {}) {
    return (async () => {
        try {
            const dispatch = deps.dispatch || require('./triggerBus/dispatch');
            const triggerBus = deps.triggerBus || require('./triggerBus');
            const subs = await store.getSubscriptionsForAutomation(automationId);
            const gmailSubs = (subs || []).filter(s => s.provider === 'gmail' && s.eventType === 'mail.new');
            for (const sub of gmailSubs) {
                try {
                    // sub.filter is the normalized copy of the trigger's filter,
                    // so fetch and dispatch agree on what "matching" means.
                    const latest = await triggerBus.fetchLatestGmailMatch(ownerId, sub.filter || null);
                    if (latest) {
                        dispatch.dispatchToSubscription(sub, { provider: 'gmail', event: 'mail.new', payload: latest });
                    }
                } catch (e) {
                    log.warn(`[automation/activate] immediate Gmail dispatch failed for ${automationId} sub ${sub.id}: ${e.message}`);
                }
            }
        } catch (e) {
            log.warn(`[automation/activate] immediate Gmail catchup failed for ${automationId}: ${e.message}`);
        }
    })();
}

/**
 * The collaborators the activate/deactivate/converge cores write through —
 * getters, so a core only loads the defaults it actually destructures.
 */
function writers(deps) {
    return {
        get store() { return deps.store || require('../stores/automationStore'); },
        get syncSubs() { return deps.syncAppEventSubscription || require('./subscriptionSync').syncAppEventSubscription; },
        get syncScheds() { return deps.syncSchedules || require('./scheduleSync').syncSchedules; },
        get wake() { return deps.wakeComplianceReview || require('./liveSideEffects').wakeComplianceReview; },
    };
}

/**
 * Switch an automation on — everything POST /:id/activate does after its access
 * check.
 *
 * Never live yet: the working copy is checked and becomes the live version in
 * the same write that sets is_active (publishWorkingCopy, exact on
 * `automation.version`; a save landing in between answers 409
 * `version_changed` instead of going live unchecked). Already has a live
 * version (a paused automation): only switches it back on, and the LIVE copy is
 * what gets checked and registered, because it is what will run.
 *
 * Then the triggers are registered from that copy (event subscriptions, extra
 * schedules re-armed so a resumed automation fires at its NEXT slot), the Gmail
 * catch-up runs in the background and compliance is woken.
 *
 * `actorId` is who switches it on (the write's actor, and the owner fallback);
 * `session` and `organizationId` feed checkBeforeLiveCore.
 *
 * @returns {Promise<{ok: true, automation, warnings}|{ok: false, status, code, message, body, raise?, details?}>}
 */
async function activateCore({ automation, actorId, session = null, organizationId = null, deps = {} }) {
    const a = automation;
    const { store, syncSubs, syncScheds, wake } = writers(deps);
    const definitionForRun = deps.definitionForRun || require('../core/automationRunner/definitionForRun').definitionForRun;
    // Subscriptions and the Gmail catch-up use the OWNER's connected account.
    const ownerId = a.userId || actorId;

    const neverLive = a.liveVersion == null;
    // An automation in a Solution stage reads its settings from the live copy too (D17).
    const managed = neverLive ? false : await (deps.isManagedAutomation || require('../core/automationRunner/stageVars').isManagedAutomation)(a);
    const def = neverLive ? (a.definition || {}) : definitionForRun(a, { mode: 'live', managed }).definition;
    const verdict = await checkBeforeLiveCore({ automation: a, definition: def, ownerId, organizationId, session, deps });
    if (!verdict.ok) return verdict;

    const plan = planGoLive(a, def, { now: deps.now ? deps.now() : Date.now(), willBeActive: true, verb: 'activate', deps });
    if (!plan.ok) return plan;
    // First-run confirmation gate removed — activation runs live immediately.
    const updates = { isActive: true, needsFirstRunConfirm: false, ...plan.columns };

    let u;
    if (neverLive && (a.kind || 'automation') === 'automation' && typeof store.publishWorkingCopy === 'function') {
        u = await store.publishWorkingCopy(a.id, { expectedVersion: a.version, columns: updates });
        if (!u) return refuse(409, 'version_changed', 'The automation changed while it was being checked. Review it and activate again.');
    } else {
        // (A store without publishWorkingCopy, a handler test's double, keeps
        // the plain write.)
        u = await store.updateAutomation(a.id, updates, actorId);
    }

    // App-event triggers need their automation_event_subscriptions row before
    // the poller will see them; idempotent delete-then-create. From the copy
    // that will RUN.
    await syncSubs(a.id, ownerId, def);
    // Extra schedule triggers, re-armed: a resumed automation fires at its NEXT
    // slot rather than catching up on the first tick.
    await syncScheds(a.id, def, { rearm: true });

    gmailCatchUp(store, a.id, ownerId, deps);

    // Live from here on — so is whatever it does with personal data. Never
    // awaited, never able to fail the activation.
    wake(a, 'activation');

    return { ok: true, automation: u, warnings: verdict.warnings };
}

/**
 * Switch an automation off — POST /:id/deactivate after its access check.
 *
 * Remote subscriptions are revoked BEFORE the local rows are deleted, with the
 * OWNER's connection (whose account they were made on). Then the row goes
 * inactive and compliance is woken (the same coalescing queue, so on-off-on-off
 * is one review).
 *
 * @returns {Promise<{ok: true, automation}>}
 */
async function deactivateCore({ automation, actorId, deps = {} }) {
    const a = automation;
    const { store, wake } = writers(deps);
    const revoke = deps.revokeRemoteSubscriptions || require('./subscriptionSync').revokeRemoteSubscriptions;
    await revoke(a.id, a.userId || actorId);
    await store.deleteSubscriptionsForAutomation(a.id);
    const u = await store.updateAutomation(a.id, { isActive: false }, actorId);
    wake(a, 'deactivation');
    return { ok: true, automation: u };
}

/**
 * The side effects after a definition went live — idempotent, retriable, and
 * never throwing (each failure is logged and returned as a warning).
 *
 *   - on an ACTIVE automation, the triggers are re-registered from the new live
 *     definition, each only when its configuration changed (fingerprints), so
 *     publishing a label edit on a Gmail automation does not re-anchor its poller
 *     cursor;
 *   - form pages;
 *   - with `saveSyncs` (the default): the form answers table, the datatable
 *     usage index and the knowledge-base sources — the syncs the PATCH route
 *     runs on save. The publish ROUTE passes `saveSyncs: false`: its working
 *     copy was saved through PATCH, which already ran them on this definition;
 *     a deploy writes the working copy without PATCH, so it needs them here;
 *   - compliance is woken (`reason`).
 *
 * @returns {Promise<{warnings: Array<{step: string, message: string}>, answers: object|null}>}
 */
async function convergeAfterPublish({
    automation, definition, previousLive = null, isActive, ownerId = null, organizationId = null,
    reason = 'publish', saveSyncs = true, deps = {},
}) {
    const a = automation || {};
    const def = definition || {};
    const owner = ownerId || a.userId || null;
    const warnings = [];
    let answers = null;
    const attempt = async (step, prefix, fn) => {
        try { await fn(); }
        catch (e) {
            log.warn(`${prefix} ${step} failed for ${a.id}: ${e.message}`);
            warnings.push({ step, message: e.message });
        }
    };

    const w = writers(deps);
    const PREFIX = '[automation/publish]';

    if (isActive) {
        let fp = null;
        await attempt('fingerprints', PREFIX, () => {
            fp = deps.fingerprints || {
                appEventFingerprint: require('./subscriptionSync').appEventFingerprint,
                hasAppEventTrigger: require('./subscriptionSync').hasAppEventTrigger,
                scheduleFingerprint: require('./scheduleSync').scheduleFingerprint,
            };
        });
        if (fp) {
            // The comparisons run inside `attempt` too: a malformed definition
            // that makes a fingerprint throw is a warning, not a throw.
            await attempt('subscription re-sync', PREFIX, async () => {
                if ((fp.hasAppEventTrigger(def) || fp.hasAppEventTrigger(previousLive))
                    && (previousLive == null || fp.appEventFingerprint(def) !== fp.appEventFingerprint(previousLive))) {
                    await w.syncSubs(a.id, owner, def);
                }
            });
            await attempt('schedule re-sync', PREFIX, async () => {
                if (previousLive == null || fp.scheduleFingerprint(def) !== fp.scheduleFingerprint(previousLive)) {
                    await w.syncScheds(a.id, def);
                }
            });
        }
    }

    await attempt('form pages', PREFIX, async () => {
        // `null` (the route without the helper) skips it; undefined is the default.
        const ensureForms = deps.ensureFormPages === undefined ? require('./liveSideEffects').ensureFormPages : deps.ensureFormPages;
        if (typeof ensureForms === 'function') await ensureForms(a.id, def);
    });

    if (saveSyncs) {
        let answersUsage = [];
        await attempt('answers table', PREFIX, async () => {
            const ensureAnswers = deps.ensureAnswersTable || require('./liveSideEffects').ensureAnswersTable;
            ({ answers, usage: answersUsage } = await ensureAnswers(a, def));
        });
        await attempt('datatable usage', PREFIX, () => {
            // A deploy is a save path of its own (automation/usageSync.savePaths.test.js).
            const syncDatatableUsage = deps.syncDatatableUsage || require('./datatableUsageSync').syncDatatableUsage;
            return syncDatatableUsage(a.id, organizationId || a.organizationId || null, def,
                { label: 'automation publish', extraEntries: answersUsage || [] });
        });
        await attempt('knowledge-base sources', PREFIX, () => {
            const syncKbSources = deps.syncKbSources || require('../core/kb/kbSourceSync').syncKbSources;
            return syncKbSources(a.id, def, { userId: owner, title: a.title || '' });
        });
    }

    await attempt('compliance wake', PREFIX, () => w.wake(a, reason));
    return { warnings, answers };
}

module.exports = {
    planGoLive,
    checkBeforeLiveCore,
    activateCore,
    deactivateCore,
    convergeAfterPublish,
    refusalError,
};

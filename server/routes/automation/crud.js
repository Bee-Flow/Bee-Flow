// §WS5 #4 — automation CRUD + activate/deactivate, extracted verbatim from
// routes/automation.js. Folders (folders.js), forms (forms.js) and templates,
// import and export (importExport.js) are registered on this router at their
// original positions; what they share with it lives in crudContext.js.
const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();

// The caller's organisation (see crudContext.js for why it is async and read
// fresh), the knowledge-base findings and the one access answer.
const { orgOf, kbFindingsFor, automationAccess, worded } = require('./crudContext');
const { registerFolderRoutes } = require('./folders');
const { registerFormRoutes } = require('./forms');
const { registerTemplateAndImportRoutes, registerExportRoute } = require('./importExport');

// The helpers save, activate and publish share live in automation/ so the
// go-live cores (automation/goLive.js) use the same ones — see
// automation/liveSideEffects.js for what each does and why it is best-effort.
const { agentsFor, wakeComplianceReview, ensureFormPages, ensureAnswersTable } = require('../../automation/liveSideEffects');
const { deactivateCore, editedPinRefusal, capturedPinWarnings } = require('../../automation/goLive');
const automationStore = require('../../stores/automationStore');
const { z, typeError } = require('../../utils/zod');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const cron = require('../../automation/cron');
const { validateDefinition } = require('../../automation/validate');
const { topicClassifierFor } = require('../../core/classify/classifierClient');

const { triggerColumnsFromDefinition } = require('../../automation/triggerColumns');
const { summariseDefinition } = require('../../automation/summarise');
require('../../automation/triggerBus');
const { syncDatatableUsage } = require('../../automation/datatableUsageSync');
const { syncKbSources } = require('../../core/kb/kbSourceSync');
const { syncSchedules, scheduleFingerprint } = require('../../automation/scheduleSync');
const { syncAppEventSubscription, revokeRemoteSubscriptions, hasAppEventTrigger, appEventFingerprint } = require('../../automation/subscriptionSync');
const { activateAutomation, publishAutomation } = require('./activate');
// Handoff 5: the trash (soft delete, restore) and the run policy a definition
// may carry. The live/working split itself lives in the store and the runner.
const { makeTrashHandlers } = require('./trash');
const { withSanitizedRunPolicy, resolveRunPolicy, runTimeoutMsFor } = require('../../core/automationRunner/runPolicy');
// Handoff 5, sharing and roles: one answer to "may this caller do that with
// this automation" (automation/access.js). Owner first and free; org admins with
// manage_automations and people/groups the automation is shared with after.
const { projectForViewer, groupsOf } = require('../../automation/access');
const trashHandlers = makeTrashHandlers({
    store: automationStore,
    access: automationAccess,
    revokeRemoteSubscriptions: (id, userId) => revokeRemoteSubscriptions(id, userId),
    wakeComplianceReview: (a, reason) => wakeComplianceReview(a, reason),
});

/**
 * P4 — WIENS automation wordt dit, als hij vanuit een app-knop wordt gemaakt?
 *
 * Een definitie met `trigger.appRef` komt van "Nieuwe vanuit deze knop" in App
 * Studio. Die automatisering bestaat om door één app-actie gedraaid te worden, en die
 * actie draait ALS DE EIGENAAR van de app: de brug
 * (appStudio/actionExecutor/automationBridge.js) weigert botweg zodra de
 * automation-eigenaar niet de app-eigenaar is. De eigenaar van de nieuwe automatisering
 * bepaalt dus met wiens rechten hij straks draait — dat is geen detail.
 *
 * De regel en het waarom staan in appStudio/appRefLookup.appRefOwnerVerdict;
 * hier gebeurt alleen het LADEN, en het laden mag niet fail-open zijn: een
 * store die eruit ligt levert `app: null` en dus een weigering, nooit een gok.
 *
 * Zonder appRef verandert er niets: een gewone automatisering hoort bij wie hem maakt.
 *
 * ── Waarom alleen op CREATE ──────────────────────────────────────────────
 *
 * Dit gaat over de EIGENAAR, en die wordt precies één keer gekozen. Dezelfde
 * poort op PUT zou een automatisering onbewerkbaar maken zodra de app waarnaar hij
 * wijst van eigenaar wisselt of verdwijnt — de eigenaar kan zijn eigen automatisering
 * dan niet eens meer opslaan om die verwijzing weg te halen. En er valt niets
 * mee te winnen: de back-pointer is een LABEL. Wie hem later naar andermans app
 * laat wijzen krijgt daar geen rechten mee — appRefLookup vertelt een
 * niet-eigenaar geen namen, en de brug blijft weigeren op eigenaarsgelijkheid.
 *
 * @returns {{ok: true, ownerId: string}|{ok: false, code, message}}
 */
async function appRefOwnerGate(definition, actorUserId) {
    const { appTriggerRef } = require('../../automation/appTriggerContract');
    const { appRefOwnerVerdict } = require('../../appStudio/appRefLookup');
    // Geen (of een half geschreven) back-pointer → geen app-poort. Een HALVE
    // wordt hieronder alsnog door validateDefinition geweigerd
    // (`app_trigger.ref_incomplete`), dus er ontstaat geen sluiproute.
    const ref = appTriggerRef(definition);
    if (!ref) return { ok: true, ownerId: actorUserId };

    let app = null;
    try {
        app = await require('../../stores/studioAppStore').getStudioApp(ref.appId);
    } catch (e) {
        // Onbekend versmalt: luidruchtig in het log, weigering naar buiten.
        log.warn(`[automation create] app ${ref.appId} unreadable; refusing to guess an owner:`, e.message);
        app = null;
    }
    return appRefOwnerVerdict({ app, actorUserId });
}


/**
 * The automations wired to one app-event provider (M2).
 *
 *   GET /api/automation?triggerProvider=meeting-notes[&triggerEvent=meeting.processed]
 *
 * ── THIS LIST IS THE CALLER'S OWN, NOT THE ORGANISATION'S ───────────
 * `getAutomationsForUser` is `WHERE user_id = $1`, so the filter can only
 * ever answer over the caller's automations. That happens to line up with the
 * dispatch reality — `emitMeetingProcessed` always carries the owner's
 * userId and `triggerBus/dispatch.js` skips every subscription belonging to
 * anybody else — but the two are independent facts and a screen built on
 * this must SAY whose list it is. A colleague opening a shared meeting sees
 * an empty list where the owner sees three, and "none" would be a lie.
 *
 * ── AN UNKNOWN PROVIDER IS A 400, NOT AN UNFILTERED LIST ────────────
 * The failure this guards against is a caller asking for a provider id that
 * does not exist — `meeting_notes` with an underscore is the live example:
 * PROVIDER_ID_RE rejects underscores, so that source never registered, and a
 * filter that quietly fell back to the whole list would hand a "automations on
 * this meeting" panel every automation the person owns. Silently returning
 * everything on a typo'd narrowing parameter is the wrong direction for a
 * list that decides what a screen claims.
 */
function appEventTriggersOf(definition) {
    const all = [definition?.trigger, ...(Array.isArray(definition?.triggers) ? definition.triggers : [])];
    return all.filter(t => t && t.kind === 'app_event' && t.appEvent?.provider);
}


// ── What a caller may send ──────────────────────────────────────────
//
// Every schema is `.strict()`: a key this router does not read is a client
// bug, and answering 200 to it means the person watches a setting they typed
// fail to stick with nothing on screen to explain it.


const PROVIDER_TEXT = 'triggerProvider is the id of a trigger source.';
const EVENT_TEXT = 'triggerEvent is the id of one of that provider\'s events.';
const ListQuery = z.object({
    triggerProvider: worded(PROVIDER_TEXT).trim().min(1, PROVIDER_TEXT).optional(),
    triggerEvent: worded(EVENT_TEXT).trim().min(1, EVENT_TEXT).optional(),
}).strict().refine((q) => q.triggerEvent === undefined || q.triggerProvider !== undefined, {
    // An event belongs to a provider, so on its own it narrows nothing — and
    // the answer to a narrowing parameter that narrows nothing used to be the
    // caller's WHOLE list. That is the failure appEventTriggersOf guards
    // against, arriving through the other half of the filter.
    path: ['triggerEvent'],
    message: 'triggerEvent only means something together with triggerProvider.',
});

const TITLE_TEXT = 'An automation needs a title.';
const DEFINITION_TEXT = 'An automation needs a definition — the flow itself.';
const TRIGGER_TYPE_TEXT = 'triggerType is text, like "manual" or "schedule".';
const CRON_TEXT = 'scheduleCron must be text — a cron expression.';
const TZ_TEXT = 'scheduleTz must be text — a time zone.';

/**
 * The flow graph itself has its own validator (automation/validate.js), which
 * reads every node and answers with a list of findings; all the schema says
 * is that a definition arrived and is an object.
 */
const Definition = z.record(z.string(), z.unknown(), { error: typeError({ required: DEFINITION_TEXT, invalid: DEFINITION_TEXT }) });

const CreateAutomationBody = z.object({
    title: worded(TITLE_TEXT).trim().min(1, TITLE_TEXT),
    description: worded('A description must be text.').nullish(),
    definition: Definition,
    triggerType: worded(TRIGGER_TYPE_TEXT).trim().min(1, TRIGGER_TYPE_TEXT).prefault('manual'),
    // Blank stays blank rather than being refused here: an empty cron on a
    // schedule trigger has its own, better-worded answer further down.
    scheduleCron: worded(CRON_TEXT).trim().nullish().prefault(null),
    scheduleTz: worded(TZ_TEXT).trim().min(1, TZ_TEXT).prefault('Europe/Amsterdam'),
    createdFromChatId: worded('createdFromChatId must be text.').trim().min(1).nullish().prefault(null),
    // Handoff 5: the gallery template this automation starts from, so v1 reads
    // "Created from template ...". Unknown ids are ignored (plain "Created").
    templateId: worded('templateId must be the id of a template.').trim().min(1).max(200).nullish().prefault(null),
}).strict();

const FOLDER_TEXT = 'folderId is the id of a folder, or null to move it back to the top level.';
const ICON_TEXT = 'icon is the name of an icon (letters, digits and dashes, at most 40 characters), or null for the default.';
const UpdateAutomationBody = z.object({
    // The automation's own symbol (a lucide icon name). Null resets it.
    icon: worded(ICON_TEXT).trim().max(40, ICON_TEXT).regex(/^[A-Za-z][A-Za-z0-9-]*$/, ICON_TEXT).nullish(),
    title: worded(TITLE_TEXT).trim().min(1, TITLE_TEXT).optional(),
    description: worded('A description must be text.').nullish(),
    definition: Definition.optional(),
    isDraft: z.boolean({ error: typeError({ invalid: 'isDraft is true or false.' }) }).optional(),
    triggerType: worded(TRIGGER_TYPE_TEXT).trim().min(1, TRIGGER_TYPE_TEXT).optional(),
    scheduleCron: worded(CRON_TEXT).trim().nullish(),
    scheduleTz: worded(TZ_TEXT).trim().nullish(),
    folderId: worded(FOLDER_TEXT).trim().nullish(),
}).strict();

/**
 * The automations shared WITH the caller (handoff 5), each with `myRole` and
 * `owner`. Read fresh from `users` (organisation and groups), like every other
 * access decision. Fail-soft: the caller's own list must not disappear because
 * the shared half could not be read.
 */
async function sharedWithCaller(req) {
    try {
        const me = await require('../../stores/userStore').getUser(req.session.user.id);
        if (!me?.organizationId) return [];
        const rows = await automationStore.listAutomationsSharedWithUser(me.id, {
            orgId: me.organizationId, groupIds: groupsOf(me),
        });
        return (rows || []).map(r => projectForViewer(r, { role: r.myRole, via: 'share' }));
    } catch (e) {
        log.warn('[automation list] shared automations unavailable:', e.message);
        return [];
    }
}

const byUpdatedDesc = (x, y) => String(y?.updatedAt || '').localeCompare(String(x?.updatedAt || ''));

router.get('/', validate({ query: ListQuery }), async (req, res) => {
    const own = await automationStore.getAutomationsForUser(req.session.user.id);
    const list = (own || []).map(a => projectForViewer(a, { role: 'owner', via: 'owner' }));

    const { triggerProvider, triggerEvent } = req.query;
    // Unfiltered: the caller's own automations and the ones shared with them,
    // newest first. The provider-filtered list below stays the caller's OWN
    // (see appEventTriggersOf): an app event only ever fires its owner's automations.
    if (triggerProvider === undefined) {
        return res.json({ automations: [...list, ...await sharedWithCaller(req)].sort(byUpdatedDesc) });
    }

    let known = null;
    try {
        known = require('../../automation/triggerSources').getTriggerSource(triggerProvider);
    } catch (e) {
        // The registry itself is unavailable. Refusing is the only honest
        // answer: an unfiltered list here is the exact failure above.
        log.warn('[automation list] trigger-source registry unavailable:', e.message);
        throw new HttpError(503, 'trigger_sources_unavailable', 'Trigger sources are unavailable');
    }
    if (!known) return res.status(400).json({ error: `Unknown trigger provider "${triggerProvider}"` });
    if (triggerEvent !== undefined && !(known.events || []).some(ev => ev.id === triggerEvent)) {
        return res.status(400).json({ error: `Unknown event "${triggerEvent}" for provider "${triggerProvider}"` });
    }

    const automations = (list || []).filter(a => appEventTriggersOf(a?.definition).some(
        t => t.appEvent.provider === triggerProvider
            && (triggerEvent === undefined || t.appEvent.event === triggerEvent),
    ));
    res.json({ automations });
});

// Create automation (default isDraft=true; finalise via PUT or activate).
/** v1's description for an automation started from a gallery template; null when the id is unknown. */
async function templateVersionMeta(templateId, userId, orgId) {
    try {
        const { getTemplateFor } = require('../../automation/templates');
        const tmpl = await getTemplateFor(templateId, { userId, orgId });
        if (!tmpl?.title) return null;
        return {
            description: `Created from template "${tmpl.title}"`,
            descriptionJson: [{ code: 'created_from_template', params: { template: tmpl.title, templateId: tmpl.id } }],
        };
    } catch (e) {
        log.warn(`[automation create] template ${templateId} unreadable: ${e.message}`);
        return null;
    }
}

router.post('/', validate({ body: CreateAutomationBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { title, description, triggerType, scheduleCron, scheduleTz, createdFromChatId, templateId } = req.body;
    let { definition } = req.body;
    // WIENS automatisering wordt dit? Alleen anders dan "van de maker" wanneer de
    // definitie een app-back-pointer draagt — zie appRefOwnerGate hierboven.
    // Vóór de validatie, want een weigering hier is over eigendom en moet
    // niet als "ongeldige definitie" bij de gebruiker aankomen.
    const ownership = await appRefOwnerGate(definition, userId);
    if (!ownership.ok) return res.status(403).json({ error: ownership.message, code: ownership.code });
    // definition.runPolicy (handoff 5): out of range is the author's to fix.
    const policy = withSanitizedRunPolicy(definition);
    if (policy.errors.length) return res.status(400).json({ error: 'Invalid definition', details: policy.errors });
    definition = policy.definition;
    // A newly created automation is a draft (isDraft defaults true), so it
    // gets the same lenient stage as PUT — the builder lazily creates the
    // row the moment the user drops their first node, long before the flow
    // is complete.
    // The agent rule is a COMPLETENESS code, so at draft stage it comes
    // back as a warning rather than blocking a half-built flow — but it
    // does come back, which is what the editor needs to draw the marker.
    const v = validateDefinition(definition, { stage: 'draft', availableAgents: await agentsFor(definition, userId), topicClassifier: await topicClassifierFor(definition) });
    if (!v.ok) return res.status(400).json({ error: 'Invalid definition', details: v.errors });
    // Assignee ORG membership — validate.js is pure, so the DB half of the
    // approval-assignee rule lives here: naming someone outside your org
    // as an approver is a save error, never a silent runtime fallback.
    const assigneeErrors = await require('../../automation/approvalService').validateApprovalAssignees(definition, userId);
    if (assigneeErrors.length) return res.status(400).json({ error: 'Invalid definition', details: assigneeErrors });
    let nextRunAt = null;
    if (triggerType === 'schedule' && scheduleCron) {
        try { nextRunAt = cron.nextRunAt(scheduleCron, scheduleTz, Date.now()); }
        catch (e) { return res.status(400).json({ error: `Bad cron: ${e.message}` }); }
    }
    const organizationId = await orgOf(req);
    const a = await automationStore.createAutomation({
        // organizationId was accepted by the store from the start and never
        // passed, so the column was NULL for every automation and the runner
        // re-derived it per run from the owner. A datatable is scoped by
        // organisation and needs it stored, not derived.
        //
        // De eigenaar komt uit de poort, niet rechtstreeks uit de sessie.
        // Voor een gewone automatisering is dat dezelfde waarde; voor één die
        // vanuit een app-knop wordt gemaakt is het de APP-EIGENAAR, en dat
        // de poort die twee gelijk heeft bevonden is precies de reden dat
        // er hier iets gemaakt mag worden. Zo staat de regel in de code in
        // plaats van in een aanname.
        userId: ownership.ownerId, organizationId,
        title: title.trim(), description: description || '',
        definition, triggerType, scheduleCron, scheduleTz, nextRunAt, createdFromChatId,
        versionMeta: templateId ? await templateVersionMeta(templateId, userId, organizationId) : null,
    });
    await ensureFormPages(a.id, definition);
    const { answers, usage: answersUsage } = await ensureAnswersTable(a, definition);
    // The builder can create an automation complete with datatable steps in one
    // POST (duplicate, template, "create from chat"), and until the author
    // happens to save it again nothing indexed those steps.
    await syncDatatableUsage(a.id, organizationId, definition, { label: 'automation create', extraEntries: answersUsage });
    await syncKbSources(a.id, definition, { userId, title: a.title });
    // An automation can arrive complete in one POST (duplicate, template,
    // "create from chat"), knowledge-base links and all. Reported, not
    // enforced: the row lands as a draft and activation is the gate.
    const kbWarnings = await kbFindingsFor(definition, req, userId, 'draft');
    res.json({ automation: a, answers, ...(kbWarnings.length ? { warnings: kbWarnings } : {}) });
});

// Folders, forms, templates and import: literal first segments, so they are
// registered here, BEFORE `/:id` (automation.routetable.test.js guards the order).
registerFolderRoutes(router);
registerFormRoutes(router);
registerTemplateAndImportRoutes(router);


// The caller's trash (handoff 5). A literal, so it sits above GET /:id.
router.get('/_trash', (req, res) => trashHandlers.listTrash(req, res));

/**
 * `managed: null | {solutionId, solutionName, stage, releaseSeq, devRef}` for
 * an automation of a Solution stage (design 5.3); the builder shows it read-only
 * and the client never derives it. The cached stage lookup answers the common
 * case without a query. A failed read is null: it labels the builder, it
 * decides nothing (the store refuses a managed write itself, 409 managed_part,
 * which reaches the terminal handler because these routes do not catch it).
 */
async function managedOf(a) {
    if (!a || !a.projectId) return null;
    try {
        if (!await require('../../stores/managedPartsDefault').managedInfo(a.projectId)) return null;
        return await require('../../stores/solutionStageStore')
            .managedPayloadFor({ projectId: a.projectId, kind: 'automation', entityId: a.id });
    } catch (e) {
        log.warn(`[automation] managed lookup failed for ${a.id}: ${e.message}`);
        return null;
    }
}

router.get('/:id', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await automationAccess.guard(req, res, a, 'run');
    if (!access) return;
    // A run-only caller gets the triggers and no steps, so no summary either.
    const summary = access.role === 'run' ? null : summariseDefinition(a.definition || {}).summary;
    res.json({ automation: projectForViewer(a, access), summary, managed: await managedOf(a) });
});

/**
 * "Gebruikt door 1 knop" — welke app-knoppen deze automatisering aanzetten (P4 deel C).
 *
 * Leest `automation_usage`, geschreven door appStudio/automationUsageSync.js op
 * elke save van een app. Eigenaar-only, precies zoals GET /:id ernaast: de
 * capsule noemt appnamen en knoplabels, en die zijn niet van een willekeurige
 * lezer.
 *
 * TWEE DINGEN DIE NIET MOGEN VERSCHUIVEN:
 *
 *   1. EEN MISLUKTE LEES IS GEEN LEGE LIJST. Valt de store om, dan antwoordt
 *      deze route een FOUT en nooit `{usage: []}` — anders leest de capsule
 *      "wordt nergens gebruikt" op het moment dat de database hikt, en dat is
 *      precies de zin waarop iemand een automatisering verwijdert die een knop in
 *      productie aanzet. De client vertaalt een fout naar "kon niet worden
 *      gecontroleerd".
 *   2. EIGENDOM VERSMALT. De rijen zijn bij het schrijven al gegrendeld op
 *      `automations.user_id`, maar een automatisering die van eigenaar is gewisseld
 *      kan rijen met de OUDE eigenaar hebben. Die horen niet bij deze lezer,
 *      dus ze vallen weg — een rij te weinig is hier de veilige kant, want de
 *      naam van andermans app tonen is dat niet.
 *   3. `canOpen` WORDT GEZEGD, NIET AFGELEID. De capsule toont een appNAAM en
 *      een LINK naar de App Studio-editor, en die editor is eigenaar-only.
 *      Eerder leunde dat op een AFLEIDING (de INSERT grendelt op
 *      `automations.user_id = <app-eigenaar>`, dus app-eigenaar == kijker) die
 *      nergens in de leeslaag stond en die wegvalt zodra er een tweede
 *      `consumer_kind` bijkomt of een app van eigenaar wisselt. Nu staat het
 *      antwoord in de rij, precies zoals `appRefLookup.describeAppRef` het
 *      geeft: een link die op een 403 landt is erger dan geen link.
 *   4. HET DERDE ANTWOORD REIST MEE. `complete:false` betekent dat de index
 *      nog niet elke app heeft gezien; de capsule mag dan niet "wordt nergens
 *      gebruikt" beweren. Meteen wordt er een backfill-pass ingepland, zodat
 *      het antwoord vanzelf compleet wordt in plaats van te wachten tot iemand
 *      toevallig die app opslaat.
 */
router.get('/:id/usage', async (req, res) => {
    try {
        const a = await automationStore.getAutomation(req.params.id);
        if (!a) return res.status(404).json({ error: 'Not found' });
        if (!await automationAccess.guard(req, res, a, 'view')) return;
        const usageStore = require('../../stores/automationUsageStore');
        const [rows, coverage] = await Promise.all([
            usageStore.listUsageOfAutomation(req.params.id),
            usageStore.usageIndexCoverage(),
        ]);
        if (!coverage.complete) {
            require('../../appStudio/automationUsageSync').backfillAutomationUsageDetached();
        }
        // Wie mag de app openen: de app-EIGENAAR, en dat wordt gelezen, niet
        // afgeleid. Eén lees per genoemde app (het zijn er een handvol), en
        // een app die niet te lezen is levert `canOpen:false` — onbekend
        // versmalt naar geen link.
        const appOwners = new Map();
        const studioAppStore = require('../../stores/studioAppStore');
        const mine = rows.filter(r => r.automationOwner === a.userId);
        for (const consumerId of new Set(mine.filter(r => r.consumerKind === 'app').map(r => r.consumerId))) {
            try {
                const app = await studioAppStore.getStudioApp(consumerId);
                appOwners.set(consumerId, app && typeof app.userId === 'string' ? app.userId : null);
            } catch (err) {
                log.warn(`[automation usage] app ${consumerId} unreadable; no link:`, err.message);
                appOwners.set(consumerId, null);
            }
        }
        const viewerId = req.session.user.id;
        res.json({
            usage: mine.map(r => ({
                ...r,
                canOpen: r.consumerKind === 'app' && !!appOwners.get(r.consumerId) && appOwners.get(r.consumerId) === viewerId,
            })),
            complete: coverage.complete,
        });
    } catch (e) {
        // A deliberate refusal the client may see (`expose`) keeps its
        // status (terminal handler); any other error is the 500 below.
        if (e?.expose === true && Number(e?.status) >= 400 && Number(e?.status) < 500) throw e;
        // Regel 1: zeggen dat het niet kon, niet doen alsof er niets is.
        log.warn('[automation usage] read failed:', e.message);
        res.status(500).json({ error: 'usage_unavailable' });
    }
});

// GET /:id/export (importExport.js), in its original place among the `/:id` routes.
registerExportRoute(router);

router.put('/:id', validate({ body: UpdateAutomationBody }), async (req, res) => {
    // The person saving (stamped as the version's author) and the OWNER the
    // automation belongs to and runs as. They differ for an `edit` share; every
    // owner-bound check below (agents, approvers, knowledge bases, the event
    // subscription) asks about the owner, like activation does.
    const userId = req.session.user.id;
    const existing = await automationStore.getAutomation(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const access = await automationAccess.guard(req, res, existing, 'edit');
    if (!access) return;
    const ownerId = existing.userId || userId;
    // The sidebar folder is the owner's filing, not a setting of the automation.
    if (req.body.folderId !== undefined && access.role !== 'owner') {
        return res.status(403).json({ error: 'Only the owner can move this automation to another folder.', code: 'automation_forbidden', need: 'owner' });
    }

    const updates = {};
    const fields = ['title', 'description', 'definition', 'isDraft', 'triggerType', 'scheduleCron', 'scheduleTz'];
    for (const f of fields) if (req.body[f] !== undefined) updates[f] = req.body[f];
    if (req.body.icon !== undefined) updates.icon = req.body.icon || null;
    // Handoff 5 — the live split. On an automation that HAS a live version this
    // save only changes the working copy: runs keep executing the live one
    // until POST /:id/publish, and everything derived from the trigger
    // (trigger_type, schedule_cron/tz, next_run_at, event subscriptions,
    // extra schedules) keeps following the LIVE definition. The store
    // enforces the column half too (lifecycle.stripLiveFollowingFields). On a
    // never-live automation nothing changes: the working copy is all there is.
    const hasLive = existing.liveVersion != null;
    if (updates.definition !== undefined) {
        const policy = withSanitizedRunPolicy(updates.definition);
        if (policy.errors.length) return res.status(400).json({ error: 'Invalid definition', details: policy.errors });
        updates.definition = policy.definition;
        // runPolicy is a SETTING: it applies immediately, live or not
        // (definitionForRun overlays it from the working copy). The stuck-run
        // reaper reads run_timeout_ms, not the definition, so keep the column
        // in step here too instead of only on publish/activate.
        const def = updates.definition;
        if (def && typeof def === 'object' && def.runPolicy && typeof def.runPolicy === 'object') {
            updates.runTimeoutMs = runTimeoutMsFor(resolveRunPolicy(def));
        }
    }
    // Which sidebar folder this automation sits in. `null` puts it back at the
    // top level, so the value is copied on `!== undefined` rather than on
    // truthiness — otherwise an automation could be filed but never unfiled.
    if (req.body.folderId !== undefined) {
        updates.folderId = req.body.folderId || null;
    }

    // Test on `!== undefined`, NOT truthiness: line 199 already copied the
    // field in on `!== undefined`, so a null/falsy definition used to skip
    // validation here and still reach the store, which coerced it to `{}`.
    // That empty object then read back as truthy and defeated every
    // `def || seed` guard in the builder, producing the trigger-only
    // definition behind "'steps' must be an array" (BFSF-318).
    // Draft stage: only INTEGRITY problems block a save. Completeness
    // problems (an unwired If branch, a tool input not filled in yet) come
    // back as warnings so the user can keep building — a save used to be
    // blocked by any incomplete node ANYWHERE in the flow, because the node
    // inspector PUTs the whole definition (BFSF-323). Activation still runs
    // the full strict pass, so nothing broken can go live.
    let saveWarnings = [];
    if (updates.definition !== undefined) {
        // Same as the create route: a warning at draft stage, an error at
        // activate. Without it, rewriting an ALREADY ACTIVE automation was the
        // one path that could point an ai_step at an agent nobody checked.
        const v = validateDefinition(updates.definition, { stage: 'draft', availableAgents: await agentsFor(updates.definition, ownerId), topicClassifier: await topicClassifierFor(updates.definition) });
        if (!v.ok) return res.status(400).json({ error: 'Invalid definition', details: v.errors });
        const assigneeErrors = await require('../../automation/approvalService').validateApprovalAssignees(updates.definition, ownerId);
        if (assigneeErrors.length) return res.status(400).json({ error: 'Invalid definition', details: assigneeErrors });
        saveWarnings = v.warnings;
        // An ACTIVE automation without a separate live version runs this very
        // working copy, so a save is a go-live: refuse hand-written pins here
        // exactly as activation does (BFSF-452). With a live version the
        // publish step re-checks.
        if (existing.isActive && !hasLive) {
            const pins = require('../../automation/portability').collectPinnedNodes(updates.definition);
            const pinRefusal = editedPinRefusal(pins, { verb: 'save' });
            if (pinRefusal) return res.status(400).json(pinRefusal);
            // Live now serves the saved sample: tell the client, as activation does.
            saveWarnings = [...saveWarnings, ...capturedPinWarnings(pins)];
        }
        // Knowledge-base links need the database, so validate.js cannot see
        // them (it is the pure pass). A WARNING while building: the builder
        // PUTs the whole definition on every node edit, and a save blocked
        // by a step somebody is halfway through configuring is how an
        // afternoon's work gets lost. Activation refuses instead.
        saveWarnings = [...saveWarnings, ...await kbFindingsFor(updates.definition, req, ownerId, 'draft')];
    }

    // Keep the denormalised trigger columns in step with the definition.
    // The scheduler claims rows by `trigger_type = 'schedule'` + the
    // schedule_cron/tz columns, never by reading the JSON — but the visual
    // editor only ever sends `definition`, so a schedule configured in the
    // node panel left trigger_type at 'manual' and never fired (BFSF-318).
    // The AI builder already does this in builderTools.persistDraft.
    // An explicit column in the request still wins (the JSON view sends
    // them directly).
    if (updates.definition !== undefined) {
        const derived = triggerColumnsFromDefinition(updates.definition);
        if (updates.triggerType === undefined) updates.triggerType = derived.triggerType;
        if (updates.scheduleCron === undefined) updates.scheduleCron = derived.scheduleCron;
        if (updates.scheduleTz === undefined) updates.scheduleTz = derived.scheduleTz;
    }
    // (On a live automation the columns derived above are still VALIDATED
    // below — a broken schedule is refused at save time — but not written.)

    // Cron validation + nextRunAt recompute must run whenever the SCHEDULE
    // changes — not only when `definition` is also present. A PUT that
    // touches just scheduleCron/scheduleTz/triggerType (e.g. the schedule
    // editor) previously skipped this entirely: a bad cron slipped through
    // unvalidated, and next_run_at was never recomputed, so an edited or
    // newly-enabled schedule ran on stale timing (or, with no prior
    // next_run_at, never fired at all).
    const scheduleTouched = updates.definition !== undefined
        || updates.triggerType !== undefined
        || updates.scheduleCron !== undefined
        || updates.scheduleTz !== undefined;
    if (scheduleTouched) {
        const triggerType = updates.triggerType || existing.triggerType;
        const scheduleCron = updates.scheduleCron !== undefined ? updates.scheduleCron : existing.scheduleCron;
        const scheduleTz = updates.scheduleTz || existing.scheduleTz;
        if (triggerType === 'schedule' && scheduleCron) {
            try {
                const next = cron.nextRunAt(scheduleCron, scheduleTz, Date.now());
                if (!next) return res.status(400).json({ error: `Schedule "${scheduleCron}" has no upcoming run time — check the day/month combination.` });
                updates.nextRunAt = next;
            } catch (e) { return res.status(400).json({ error: `Bad cron: ${e.message}` }); }
        } else {
            // A schedule trigger that KEEPS trigger_type='schedule' but loses
            // its cron used to fall between the two old branches: nothing
            // recomputed next_run_at (no cron) and nothing cleared it (the
            // trigger type had not changed), so the row kept a stale, now-past
            // next_run_at. claimDueAutomations only looks at
            // trigger_type/next_run_at, and the runner's post-run advance is
            // gated on scheduleCron — so the automation re-ran, with live side
            // effects, every single scheduler tick, forever. Emptying the
            // "custom pattern" field in the trigger inspector was enough
            // (triggerColumnsFromDefinition maps a missing trigger.schedule.cron
            // to null). Clear next_run_at whenever we did NOT compute one.
            if (triggerType === 'schedule' && scheduleWasConfigured(req.body, updates)) {
                // ...and refuse the save outright when the user actually
                // configured a schedule and left it empty: a schedule trigger
                // with no schedule can never fire, so silently accepting it
                // just produces an automation that looks armed and is not. A
                // freshly dropped, not-yet-configured schedule node is NOT
                // this case — it must stay savable (draft-stage saves are
                // deliberately lenient, BFSF-323).
                return res.status(400).json({ error: 'Schedule trigger has no schedule — pick a time (or a custom pattern) before saving.' });
            }
            updates.nextRunAt = null;
        }
    }

    if (hasLive) {
        delete updates.triggerType;
        delete updates.scheduleCron;
        delete updates.scheduleTz;
        delete updates.nextRunAt;
    }
    // `false` when nothing was left to write (a live automation's schedule
    // columns only, stripped above): the row stands as it was.
    const updated = (await automationStore.updateAutomation(req.params.id, updates, userId)) || existing;

    // A trigger switched TO `form` needs its public page; one switched away
    // keeps its row, exactly as before — the page survives so the old link
    // can be reinstated, and loadForm already refuses to serve it.
    if (updates.definition !== undefined) await ensureFormPages(req.params.id, updates.definition);
    // The form's answers table follows the definition on the same save.
    let answers = null;
    let answersUsage = [];
    if (updates.definition !== undefined) {
        ({ answers, usage: answersUsage } = await ensureAnswersTable(updated || existing, updates.definition));
    }

    // Keep the datatable dependents index in step with the definition. It
    // is written HERE, on the author's own save, because nobody may scan a
    // colleague's automations to derive it later — getAutomationsForUser is
    // WHERE user_id = $1. Never fail a save over the index.
    if (updates.definition !== undefined) {
        await syncDatatableUsage(req.params.id, await orgOf(req), updates.definition,
            { label: 'automation update', extraEntries: answersUsage });
        // The Sources list of a knowledge base has to name the automations
        // that feed it from the moment they are SAVED, not from their
        // first successful run — that gap is exactly when somebody is
        // deciding whether the base can be trusted.
        await syncKbSources(req.params.id, updates.definition,
            { userId: ownerId, title: updates.title || existing?.title || '' });
    } else if (updates.title !== undefined) {
        // A rename with no definition change still has to reach the source
        // row: the builder's inline rename sends title only, and the name
        // is the one thing a person recognises a source by in the Sources
        // list. Reuses the STORED definition — nothing about it changed.
        await syncKbSources(req.params.id, existing?.definition || {},
            { userId: ownerId, title: updates.title });
    }

    // If the definition changed on an ACTIVE automation whose trigger is an
    // app_event, re-sync its event subscription — otherwise an edit to the
    // trigger provider/event/filter leaves the old subscription in place
    // and the automation keeps firing on the STALE criteria (or stops
    // firing if the trigger was removed). syncAppEventSubscription is
    // idempotent (delete-then-create) and provider-agnostic.
    //
    // Fingerprint gate (A12): only re-sync when the app-event trigger
    // CONFIG actually changed. Every definition save used to
    // delete-and-recreate the subscription — nudging a node position on
    // an active Gmail automation re-anchored the poller cursor to "now" and
    // silently dropped every event since the last poll.
    if (updates.definition && !hasLive && (updated?.isActive ?? existing.isActive)) {
        const def = updated?.definition || updates.definition;
        if (hasAppEventTrigger(def) || hasAppEventTrigger(existing.definition)) {
            if (appEventFingerprint(def) !== appEventFingerprint(existing.definition)) {
                try { await syncAppEventSubscription(req.params.id, ownerId, def); }
                catch (e) { log.warn(`[automation update] subscription re-sync failed for ${req.params.id}: ${e.message}`); }
            }
        }
        // Same gate for ADDITIONAL schedule triggers: their rows live in
        // automation_schedules and only need touching when a cron/tz
        // changed or a schedule trigger came or went.
        if (scheduleFingerprint(def) !== scheduleFingerprint(existing.definition)) {
            try { await syncSchedules(req.params.id, def); }
            catch (e) { log.warn(`[automation update] schedule re-sync failed for ${req.params.id}: ${e.message}`); }
        }
    }

    res.json({ automation: projectForViewer(updated, access), warnings: saveWarnings, ...(answers ? { answers } : {}) });
});

// Into the trash, not gone: switched off, remote subscriptions revoked, runs
// and answers tables kept for TRASH_RETENTION_DAYS (routes/automation/trash.js;
// the final delete and its index cleanup are jobs/automationTrashPurge.js).
router.delete('/:id', (req, res) => trashHandlers.trash(req, res));

// Out of the trash again — always paused. The literal-first route (GET
// /_trash) is registered above GET /:id.
router.post('/:id/restore', (req, res) => trashHandlers.restore(req, res));

// The AI Act gate on activate and publish (handoff 5): only in an organisation
// with the compliance hub licence. Bee checks the automation first and records
// what it can answer itself (automation/aiActAuto.js); the gate then refuses
// only with the questions it could not (automation/aiActCheck.gateRefusal).
const aiActState = require('../../automation/aiActAuto').defaultAiActAuto().gateState;

router.post('/:id/activate', (req, res) =>
    activateAutomation(req, res, { agentsFor, kbFindingsFor, wakeComplianceReview, access: automationAccess, aiActState }));

// "Make vN live" (handoff 5): the working copy becomes the live version.
// Body `{ version? }` — the version the person reviewed (409 if it moved on).
const PublishBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    version: z.number({ error: typeError({ invalid: 'version is the version number you reviewed.' }) })
        .int('version is a whole number.').positive('version is a whole number.').optional(),
}).strict());
router.post('/:id/publish', validate({ body: PublishBody }), (req, res) =>
    publishAutomation(req, res, { agentsFor, kbFindingsFor, wakeComplianceReview, ensureFormPages, access: automationAccess, aiActState }));

router.post('/:id/deactivate', async (req, res) => {
    const a = await automationStore.getAutomation(req.params.id);
    if (!a) return res.status(404).json({ error: 'Not found' });
    const access = await automationAccess.guard(req, res, a, 'edit');
    if (!access) return;

    // automation/goLive.deactivateCore: remote subscriptions revoked BEFORE
    // the local rows are deleted (with the OWNER's connection), the row off,
    // and compliance woken — switching OFF changes the posture too, and the
    // same coalescing queue turns on-off-on-off into one review.
    const { automation: u } = await deactivateCore({
        automation: a,
        actorId: req.session.user.id,
        deps: { store: automationStore, revokeRemoteSubscriptions, wakeComplianceReview },
    });
    res.json({ automation: projectForViewer(u, access) });
});


/**
 * Did this PUT actually CONFIGURE a schedule, as opposed to merely carrying a
 * schedule trigger nobody has set up yet?
 *
 * The distinction is what keeps the 400 above from breaking the builder: the
 * palette drops a schedule trigger as a bare `{ kind:'schedule' }` node and the
 * canvas PUTs the definition straight away, long before the inspector is
 * opened — that save has to succeed (draft saves are deliberately lenient,
 * BFSF-323). The moment the inspector writes a `trigger.schedule` block, or a
 * caller sends the denormalised columns directly (the JSON view and the
 * schedule editor do), an empty cron is a real user error.
 *
 * Reads `req.body`, NOT `updates`: by the time this runs, updates.scheduleCron
 * has already been back-filled from the definition for every definition PUT.
 */
function scheduleWasConfigured(body, updates) {
    if (body?.scheduleCron !== undefined) return true;
    if (body?.triggerType === 'schedule') return true;
    return updates.definition?.trigger?.schedule !== undefined;
}


module.exports = router;

/**
 * THE PLAYBOOK ITSELF — list, create, read and the client's transitions, plus
 * the delete that registers last.
 *
 * `GET /:id` is where a running build is HEALED: a fill phase is refreshed
 * from its run, and a server-run phase still `running` long after the request
 * that owned it should have finished is failed, because `running → ready` is
 * not a transition and the page would otherwise poll for ever.
 *
 * `PATCH /:id` is the only door the two CLIENT-driven builders come through,
 * so every artifact they claim is re-verified here against the owner.
 */

'use strict';

const lifecycle = require('../../playbooks/lifecycle');
const { refreshFillPhase } = require('../../playbooks/phases/fillPhase');
const { copyFor } = require('../../playbooks/copy');
const { userIdOf } = require('../studio/shared');
const {
    z, sendErr, isObject, localeOfRequest,
    worded, closedObject, bodyOf, localeCode, tierName, check,
    MAX_TITLE, MAX_FOLDER, MAX_DESCRIPTION, MAX_BRIEF, TABLE_MODES, CLIENT_STATUSES,
} = require('./contract');
const { kindOf, localeOf, withClosingPhases, summarise } = require('./phaseList');
const log = require('../../telemetry/log');

// Server-run phases whose POST owns the whole run: table (seconds), design
// (90 s model budget), compliance (reads + a 12 s review budget). A phase of
// one of those kinds still `running` this long after startedAt means the
// request that owned it died — GET fails it so Retry works (2026-09-17).
const STALE_SERVER_RUN = new Set(['table', 'design', 'compliance']);
const STALE_SERVER_RUN_MS = 10 * 60_000;

// -- What CREATE may say ---------------------------------------------
//
// Every option was read with a fall-back and none of them said anything:
// `tableMode` that is not 'new'/'existing' became **new** (a second table
// beside the one the person picked), `tier` that is not a tier became
// **fast**, and a misspelled key -- `aproverGroupId`, `tabelTitle` -- was
// dropped, so the playbook was created without the thing it was asked for
// and answered 201 with the row. A `tier` that is a tier is then measured
// against the caller's own list (phaseFlow.tierFor).
//
// `inputs` stays OPEN: its keys are the RECIPE's own input keys, read below
// against `recipe.inputs`, and a schema here would have to know every recipe.
// `recipe` stays open for the same reason -- it is the composed document,
// and `recipeDoc.validateRecipeDoc` is the thing that reads it.
const MODE_TEXT = 'tableMode is "new" or "existing".';
const CreateOptions = closedObject({
    locale: localeCode().nullish(),
    tier: tierName().optional(),
    tableMode: worded(MODE_TEXT).trim().refine((v) => TABLE_MODES.has(v), MODE_TEXT).optional(),
    datatableId: worded('datatableId is the id of a table.').trim().nullish(),
    tableTitle: worded('tableTitle must be text.').nullish(),
    folderPath: worded('folderPath is an absolute Nextcloud path (/…).').nullish(),
    approverGroupId: worded('approverGroupId is the id of a group.').trim().nullish(),
    ask: worded('ask is what the person asked for, in their own words.').nullish(),
    inputs: z.record(z.unknown(), { invalid_type_error: 'inputs is a map of the recipe\'s own fields.' }).nullish(),
}, 'options');

const CreateBody = bodyOf({
    recipeId: worded('recipeId is the id of a recipe.').trim().nullish(),
    recipe: z.record(z.unknown(), { invalid_type_error: 'recipe is the playbook document.' }).nullish(),
    title: worded('title must be text.').nullish(),
    options: CreateOptions.nullish(),
});

// -- What PATCH may say ----------------------------------------------
//
// The VALUES of a patch stay with the route: `phases[]` is the transition
// language of playbooks/lifecycle.js, and each entry is measured against the
// phase it names, with its own 409 and its own code. What was open and should
// not have been is the envelope around them. Every key was read with a
// fall-back, and a fall-back answered 200:
//
//   - `{ stauts: 'stopped' }` stopped nothing, and said so with the playbook;
//   - `phases: { key: 'table', status: 'done' }` (an object, not a list) was
//     read as "no entries", and the playbook was saved unchanged;
//   - `{ key: 'table', staus: 'done' }` was an entry with nothing to do;
//   - `expectedVersion: true` was `Number(true)`, which is 1 -- so on a
//     playbook at version 1 a boolean passed the optimistic lock, and `[3]`
//     passed it at version 3.
//
// `status` (top level and per entry) keeps the route's own sentences, so the
// schema only names it. `summary` and `error` stay loose too: the stages send
// whatever their own failure carried, and refusing a `failed` transition over
// the TYPE of its message would leave a dead phase that cannot say it died.
const VERSION_TEXT = 'expectedVersion is the version this playbook had when you read it.';
const PatchLock = z.preprocess((v) => (isObject(v) ? v : {}), z.object({
    expectedVersion: z.union([z.number().int(), z.string().trim().regex(/^\d+$/).transform(Number)], { errorMap: () => ({ message: VERSION_TEXT }) }),
}).passthrough());

const ENTRY_TEXT = 'A phase entry names its phase (key) and may carry status, artifacts, summary, error and brief.';
const PatchEntry = z.object({
    key: worded('A phase entry names its phase (key).'),
    status: z.unknown().optional(),
    artifacts: z.record(z.unknown(), { invalid_type_error: 'artifacts is a document.' }).optional(),
    summary: z.unknown().optional(),
    error: z.unknown().optional(),
    brief: worded('brief is text.').optional(),
}, { invalid_type_error: ENTRY_TEXT }).strict(ENTRY_TEXT);
const PATCH_TEXT = 'A playbook patch carries expectedVersion, and may carry status, title and phases.';
const PatchBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    expectedVersion: z.unknown(),
    status: z.unknown().optional(),
    title: worded('title is text.').optional(),
    phases: z.array(PatchEntry, { invalid_type_error: 'phases is a list of phase entries.' }).optional(),
}, { invalid_type_error: PATCH_TEXT }).strict(PATCH_TEXT));

function register(router, ctx) {
    const { d, flow, requireManageApps } = ctx;
    const { resolveRecipe, approvalsAllowed, resolveOwnerOrgId, load, prepareNext, persist } = flow;

    router.get('/', async (req, res) => {
        try {
            const rows = await d.playbookStore.listPlaybooksForUser(userIdOf(req), { limit: 100 });
            res.json({ playbooks: rows.map((pb) => summarise(pb, resolveRecipe(pb))) });
        } catch (e) {
            log.error('[Playbooks] list failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not list playbooks');
        }
    });

    router.post('/', requireManageApps, async (req, res) => {
        try {
            const parsed = check(res, CreateBody, req.body, 'bad_options');
            if (!parsed.ok) return;
            const body = parsed.value;
            // The tier is stored, and every builder this playbook drives runs
            // pinned to it: it has to be one this person may use, not only A
            // tier. `auto` is stored as `auto` (the builders choose per turn,
            // the server phases per call), and no tier stores the one
            // tierFor chooses. That used to be `fast` without asking, and a
            // playbook whose owner may not use fast was refused by both
            // builders on every phase.
            const askedTier = body.options ? body.options.tier : undefined;
            const chosenTier = await flow.tierFor(req, res, askedTier);
            if (!chosenTier) return;
            let recipe = null;
            let recipeDoc = null;
            if (isObject(body.recipe)) {
                // A custom playbook: the document travels with the request and
                // is stored on the row; the built-in ids stay modules.
                const doc = d.recipeDoc.normaliseRecipeDoc(body.recipe, { source: body.recipe.source === 'user' ? 'user' : 'ai', locale: localeOfRequest(isObject(body.options) ? body.options.locale : null) });
                const check = d.recipeDoc.validateRecipeDoc(doc);
                if (!check.ok) return sendErr(res, 400, 'recipe_invalid', 'The playbook definition is not runnable.', { errors: check.errors });
                if (d.recipes.getRecipe(doc.id)) doc.id = `custom_${doc.id}`;
                recipeDoc = doc;
                recipe = d.recipeDoc.fromDocument(doc);
            } else {
                recipe = d.recipes.getRecipe(body.recipeId);
                if (!recipe) return sendErr(res, 400, 'recipe_unknown', 'Unknown recipe.');
            }
            const o = body.options || {};
            // The interface language the dialog was in — the demo is built in
            // it: the table's columns, the briefs, the app's labels, and every
            // summary this router writes afterwards.
            const locale = localeOfRequest(o.locale);
            if (o.locale === undefined) log.info('[Playbooks] create without a locale — building in English');
            const recipeInputs = (typeof recipe.toDocument === 'function' ? (recipe.toDocument(locale) || {}).inputs : recipe.inputs) || [];
            const hasTable = recipe.hasTable !== false;
            const tableMode = hasTable && o.tableMode ? o.tableMode : 'new';
            if (hasTable && tableMode === 'existing' && (typeof o.datatableId !== 'string' || !o.datatableId)) return sendErr(res, 400, 'bad_options', 'Pick the existing table.');
            // The recipe's inputs: `options.inputs[key]`, with `folderPath` also
            // accepted at the top level (the first recipe's shape).
            const rawInputs = { ...(isObject(o.inputs) ? o.inputs : {}), ...(typeof o.folderPath === 'string' ? { folderPath: o.folderPath } : {}) };
            const inputs = {};
            for (const spec of recipeInputs) {
                const v = typeof rawInputs[spec.key] === 'string' ? rawInputs[spec.key].trim() : (typeof spec.default === 'string' ? spec.default : '');
                if (spec.kind === 'folder') {
                    if (!v || !v.startsWith('/') || v.length > MAX_FOLDER) return sendErr(res, 400, 'bad_options', `${spec.label || spec.key} must be an absolute Nextcloud path (/…).`);
                } else if (v.length > 300) return sendErr(res, 400, 'bad_options', `${spec.label || spec.key} is too long.`);
                inputs[spec.key] = v;
            }
            const folderPath = inputs.folderPath || null;
            const tier = askedTier === undefined ? chosenTier : askedTier;
            const recipeTitle = typeof recipe.titleFor === 'function' ? recipe.titleFor(locale) : recipe.title;
            const title = String(body.title || recipeTitle).trim().slice(0, MAX_TITLE) || recipeTitle;
            const userId = userIdOf(req);
            const organizationId = await resolveOwnerOrgId(userId);
            let approverGroupId = null;
            if (typeof o.approverGroupId === 'string' && o.approverGroupId) {
                const all = await d.userStore.getAllGroups().catch(() => []);
                const g = (all || []).find((x) => x.id === o.approverGroupId);
                if (!g || (organizationId && g.organizationId && g.organizationId !== organizationId)) return sendErr(res, 400, 'bad_options', 'That approver group is not in your organisation.');
                approverGroupId = g.id;
            }
            const options = {
                tableMode, datatableId: tableMode === 'existing' ? o.datatableId : null,
                tableTitle: typeof o.tableTitle === 'string' && o.tableTitle.trim() ? o.tableTitle.trim().slice(0, MAX_TITLE) : (typeof recipe.tableTitleFor === 'function' ? recipe.tableTitleFor(locale) : title),
                folderPath, inputs, tier, locale, approverGroupId,
                // WHAT THE PERSON ACTUALLY ASKED FOR, verbatim. The recipe
                // document is the AI's reading of it; the designer needs the
                // original, or it invents screens nobody asked for ("just one
                // screen in the app" produced two — owner, 2026-09-16).
                ask: typeof o.ask === 'string' && o.ask.trim() ? o.ask.trim().slice(0, MAX_DESCRIPTION) : null,
            };
            const phases = withClosingPhases(recipe.phasesFor(options, { approvalsAllowed: await approvalsAllowed(req) }), copyFor(locale));
            const pb = await d.playbookStore.createPlaybook({ userId, organizationId, recipeId: recipe.RECIPE_ID, recipe: recipeDoc, title, options, phases, currentPhase: phases[0] ? phases[0].key : null });
            res.status(201).json({ playbook: pb });
        } catch (e) {
            log.error('[Playbooks] create failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not create the playbook');
        }
    });

    // ── read (refreshes a running fill, fails a server phase whose run died) ──

    router.get('/:id', async (req, res) => {
        try {
            let pb = await load(req, res);
            if (!pb) return;
            const fill = (pb.phases || []).find((p) => kindOf(p) === 'fill' && p.status === 'running') || null;
            if (fill) {
                const change = await refreshFillPhase(fill, d, d.now(), { locale: localeOf(pb) });
                if (change) {
                    let phases = pb.phases.map((p) => (p.key === fill.key ? { ...p, artifacts: change.artifacts } : p));
                    if (change.status !== 'running') phases = lifecycle.applyTransition(phases, fill.key, change.status, { summary: change.summary || null, error: change.error || null });
                    const saved = await d.playbookStore.savePhases(pb.id, pb.userId, { phases }, { expectedVersion: pb.version });
                    pb = saved.ok ? saved.playbook : (await d.playbookStore.getPlaybook(pb.id, pb.userId)) || pb;
                }
            }
            // Table/design/compliance run INSIDE their POST: a phase still
            // `running` long after that request's own budgets means the process
            // died mid-write (or the closing save lost a race before
            // savePhaseOutcome existed). `running → ready` is illegal and the
            // client offers Skip only for client-run kinds, so without this the
            // row polled for ever. Fail it — Retry is the way out.
            const staleServer = (pb.phases || []).find((p) => STALE_SERVER_RUN.has(kindOf(p)) && p.status === 'running'
                && Number.isFinite(Date.parse(p.startedAt || '')) && d.now() - Date.parse(p.startedAt) > STALE_SERVER_RUN_MS);
            if (staleServer) {
                const phases = lifecycle.applyTransition(pb.phases, staleServer.key, 'failed', { error: copyFor(localeOf(pb)).runTimedOut }, new Date(d.now()).toISOString());
                const saved = await d.playbookStore.savePhases(pb.id, pb.userId, { phases }, { expectedVersion: pb.version });
                pb = saved.ok ? saved.playbook : (await d.playbookStore.getPlaybook(pb.id, pb.userId)) || pb;
            }
            res.json({ playbook: pb });
        } catch (e) {
            log.error('[Playbooks] get failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not load the playbook');
        }
    });

    // ── the client's transitions ────────────────────────────────────────────

    /**
     * The envelope is closed (PatchLock, PatchBody above); the VALUES are
     * not. `phases[]` is the transition language of `playbooks/lifecycle.js`,
     * and every entry is measured against the phase it names -- which status
     * may follow which, which artifacts that kind needs, which kinds the
     * SERVER runs. Those checks are below, each with its own 409 and its own
     * code, and a value schema in front of them would answer first and say less.
     */
    router.patch('/:id', requireManageApps, async (req, res) => {
        try {
            const pb = await load(req, res);
            if (!pb) return;
            const lock = check(res, PatchLock, req.body, 'version_required');
            if (!lock.ok) return;
            const parsed = check(res, PatchBody, req.body, 'bad_patch');
            if (!parsed.ok) return;
            const body = parsed.value;
            const expectedVersion = lock.value.expectedVersion;
            if (expectedVersion !== pb.version) return sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: pb.version, playbook: pb });
            const recipe = resolveRecipe(pb);
            let phases = pb.phases;
            let status = undefined;
            let currentPhase = undefined;
            let title = undefined;
            if (typeof body.title === 'string' && body.title.trim()) title = body.title.trim().slice(0, MAX_TITLE);
            if (body.status === 'stopped') status = 'stopped';
            else if (body.status === 'active') {
                // Resume: a phase that was running when the person stopped
                // was cut mid-turn — it lands as failed ("interrupted") so the
                // handoff card offers Retry / Skip / Stop rather than a stage
                // waiting for a turn nobody restarts.
                if (pb.status !== 'stopped') return sendErr(res, 409, 'illegal_transition', 'Only a stopped playbook resumes.', { from: pb.status, to: 'active' });
                status = 'active';
                for (const p of phases) {
                    if (p.status === 'running') phases = lifecycle.applyTransition(phases, p.key, 'failed', { error: 'interrupted' }, new Date(d.now()).toISOString());
                }
            } else if (body.status !== undefined) return sendErr(res, 400, 'bad_patch', 'status may only be set to "stopped" or "active".');

            const entries = Array.isArray(body.phases) ? body.phases : [];
            for (const entry of entries) {
                if (!isObject(entry) || !lifecycle.phaseByKey(phases, entry.key)) return sendErr(res, 400, 'bad_patch', `Unknown phase ${JSON.stringify(entry && entry.key)}.`);
                const cur = lifecycle.phaseByKey(phases, entry.key);
                const patch = {};
                if (isObject(entry.artifacts)) patch.artifacts = entry.artifacts;
                if (typeof entry.summary === 'string') patch.summary = entry.summary.slice(0, 600);
                if (typeof entry.error === 'string') patch.error = entry.error.slice(0, 600);
                if (typeof entry.brief === 'string') {
                    if (entry.brief.length > MAX_BRIEF) return sendErr(res, 400, 'bad_patch', `brief is over ${MAX_BRIEF} characters.`);
                    if (!['ready', 'pending'].includes(cur.status)) return sendErr(res, 409, 'illegal_transition', 'The brief can only change before the phase starts.', { from: cur.status, to: cur.status });
                    patch.brief = entry.brief;
                    patch.briefEdited = true;
                }
                if (entry.status === undefined) {
                    if (Object.keys(patch).length) phases = phases.map((p) => (p.key === entry.key ? { ...p, ...patch, artifacts: { ...(p.artifacts || {}), ...(patch.artifacts || {}) } } : p));
                    continue;
                }
                if (!CLIENT_STATUSES.has(entry.status)) return sendErr(res, 400, 'bad_patch', `A client may set running, awaiting, failed or done — not ${JSON.stringify(entry.status)}.`);
                if (!lifecycle.canTransition(cur.status, entry.status)) return sendErr(res, 409, 'illegal_transition', `Phase ${entry.key} cannot go from ${cur.status} to ${entry.status}.`, { from: cur.status, to: entry.status });
                if (entry.status === 'awaiting') {
                    const art = { ...(cur.artifacts || {}), ...(patch.artifacts || {}) };
                    const kind = kindOf(cur);
                    if (kind === 'routine') {
                        if (!art.automationId) return sendErr(res, 409, 'artifacts_missing', 'The routine phase needs the automation id.');
                        const a = await d.automationStore.getAutomation(art.automationId);
                        if (!a) return sendErr(res, 409, 'artifacts_missing', 'That routine does not exist.');
                        if (a.userId !== pb.userId) return sendErr(res, 403, 'not_owner', 'That routine is not yours.');
                        if (a.isDraft) return sendErr(res, 409, 'routine_not_finalized', 'The routine is still a draft — the builder has not finalised it.');
                        // The fill phase REFUSES a non-manual trigger, and it
                        // used to find out one phase too late: the routine
                        // landed, the playbook advanced, and the next phase died
                        // with a sentence about triggers on an automation the
                        // builder had already closed. Say it here, while the
                        // builder is still open and the person can fix it.
                        const trigger = a.definition && a.definition.trigger && a.definition.trigger.kind;
                        const feedsAFill = (pb.phases || []).slice((pb.phases || []).findIndex((x) => x.key === entry.key) + 1).some((x) => kindOf(x) === 'fill' && !lifecycle.TERMINAL.has(x.status));
                        if (feedsAFill && trigger && trigger !== 'manual') {
                            return sendErr(res, 409, 'trigger_not_manual', `This routine starts on "${trigger}", not by hand — the next phase runs it once, which needs a manual trigger.`);
                        }
                        patch.artifacts = { ...art, automationTitle: a.title || art.automationTitle || null };
                    }
                    if (kind === 'app' || kind === 'app_turn' || kind === 'access') {
                        if (!art.appId) return sendErr(res, 409, 'artifacts_missing', 'The app phase needs the app id.');
                        const app = await d.studioAppStore.getStudioApp(art.appId);
                        if (!app) return sendErr(res, 409, 'artifacts_missing', 'That app does not exist.');
                        if (app.userId !== pb.userId) return sendErr(res, 403, 'not_owner', 'That app is not yours.');
                        patch.artifacts = { ...art, appName: app.name || null };
                    }
                    if (kind === 'table' || kind === 'fill' || kind === 'design' || kind === 'compliance') return sendErr(res, 409, 'illegal_transition', `The server runs the ${entry.key} phase; POST /phases/${entry.key}/run.`, { from: cur.status, to: 'awaiting' });
                }
                if (entry.status === 'done') {
                    const adv = lifecycle.advance(phases, entry.key, new Date(d.now()).toISOString());
                    phases = adv.phases;
                    phases = await prepareNext(recipe, pb, phases, adv.nextKey, req);
                    // A second entry for the NEXT phase's edited brief lands in the same write.
                    currentPhase = lifecycle.currentPhaseKey(phases);
                    if (!adv.nextKey || !currentPhase) status = 'done';
                    continue;
                }
                if (entry.status === 'running' && ['table', 'fill', 'design', 'compliance'].includes(kindOf(cur))) return sendErr(res, 409, 'illegal_transition', `The server runs the ${entry.key} phase; POST /phases/${entry.key}/run.`, { from: cur.status, to: 'running' });
                phases = lifecycle.applyTransition(phases, entry.key, entry.status, patch, new Date(d.now()).toISOString());
                if (entry.status === 'running') currentPhase = entry.key;
            }
            if (status === undefined && lifecycle.playbookStatus(phases) === 'done') status = 'done';
            if (currentPhase === undefined) currentPhase = lifecycle.currentPhaseKey(phases);
            const saved = await persist(res, pb, { phases, currentPhase, status, title }, pb.version);
            if (saved) res.json({ playbook: saved });
        } catch (e) {
            if (e.code === 'illegal_transition') return sendErr(res, 409, 'illegal_transition', e.message, { from: e.from, to: e.to });
            if (e.code === 'artifacts_missing') return sendErr(res, 409, 'artifacts_missing', e.message);
            log.error('[Playbooks] patch failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not update the playbook');
        }
    });

}

/**
 * Registered LAST, exactly where it was: the matching order of this router is
 * the order these files are registered in, and DELETE /:id closed it.
 */
function registerDelete(router, ctx) {
    const { d, requireManageApps } = ctx;

    router.delete('/:id', requireManageApps, async (req, res) => {
        try {
            const gone = await d.playbookStore.deletePlaybook(req.params.id, userIdOf(req));
            if (!gone) return sendErr(res, 404, 'not_found', 'Not found');
            res.status(204).end();
        } catch (e) {
            log.error('[Playbooks] delete failed:', e.message);
            sendErr(res, 500, 'internal', 'Could not delete the playbook');
        }
    });
}

module.exports = { register, registerDelete };

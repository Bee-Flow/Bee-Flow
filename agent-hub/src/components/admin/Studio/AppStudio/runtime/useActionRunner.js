import { tryEvaluate } from '@shared/expr/engine.mjs';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { reconcileVariableDefaults, seedVariableDefaults } from './appVariables';
import { closeAppModal, openAppModal } from './components/AppModal';
import { resetAppForm } from './formContext';
import { resolveBinding } from './resolveBinding';
import { buildScope } from './RuntimeContext';
import { parseSseStream } from './sseStream';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import toast from '../../../../shared/Toast';

/**
 * App Studio runtime — the live action engine (SEQUENCE COORDINATOR).
 *
 * useActionRunner(appId, definition, { draft, onNavigate, confirm, onRefresh,
 *                                      currentUser, dataState })
 *   → { actionState, runAction, vars, setVar }
 *
 * `vars` is HOOK STATE shared across the whole run surface: sequences start
 * from it, and set_variable / resultVar writes merge back into it, so a value
 * set by one action is visible to formulas (vars.*) and later actions.
 * setVar(name, value) writes it directly (e.g. filter_bar). Loop-local
 * itemVar/indexVar stay sequence-local. Existing callers that destructure only
 * { actionState, runAction } are unaffected.
 *
 * An action is either a bare v1 action (kind run_automation/navigate/toast/
 * open_url/open_modal — an implicit 1-step sequence) or a v2
 * { kind:'sequence', steps:[Step] }. runAction resolves the action and:
 *
 *   • BARE v1 actions keep their exact legacy behaviour (below) — including the
 *     run_automation /run bridge with 202-poll and onSuccess/onError effects.
 *   • v2 SEQUENCES are walked step-by-step. CLIENT kinds run in the browser:
 *       navigate → onNavigate(screenId, resolvedParams) — the optional params
 *                  map ({kind:'static'|'formula'}) resolves against live scope
 *       toast    → shared toast
 *       open_url → window.open (https only)  open_modal/close_modal → the
 *       AppModal open bus (openAppModal/closeAppModal by modalId)
 *       confirm  → await a confirm promise (decline ABORTS the sequence)
 *       set_variable → writes the shared `vars` map threaded into later steps
 *       refresh  → onRefresh(actionId) (refetch the app's data)
 *       condition/switch/loop → evaluate the expr/source via @shared/expr
 *                               against the live scope and recurse/iterate
 *     SERVER kinds (create_record/update_record/delete_record/run_automation)
 *     POST to /api/studio-apps/:id/actions/:actionId/step {stepIndex, formValues,
 *     vars, item} (+?draft=1 in editor preview); the result threads into
 *     `vars`/actionState for later steps. A step failing with
 *     code 'quota_exceeded' surfaces the distinct storage-limit toast.
 *
 * A step failure aborts the remaining sequence (its optional onError branch runs
 * first) and surfaces an error toast. Only a sequence that touches the server
 * shows the triggering control's spinner (status:'running'); pure client
 * sequences resolve synchronously, exactly like a v1 navigate/toast.
 *
 * actionState: { [actionId]: { status: 'idle'|'running'|'success'|'error',
 *                              result, error } }
 * The hook is mode-agnostic: the editor never calls runAction (it stubs one).
 */

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 90000;

// Ceiling on loop iterations client-side (matches LIMITS.MAX_ACTION_LOOP_ITERATIONS).
const MAX_LOOP_ITERATIONS = 200;

// Sentinel thrown when polling is abandoned because the hook is no longer alive
// (unmount / leaving run mode). It lets a catch tell a cancellation apart from a
// real failure so it can skip BOTH the error state and the onError effects.
const CANCELLED = Symbol('useActionRunner.cancelled');
// Sentinel that unwinds a sequence cleanly (a declined confirm, or an onError
// branch that already handled the failure) — no error state, no toast.
const SEQ_ABORT = Symbol('useActionRunner.abort');

// Server-authoritative step kinds — dispatched to the /step endpoint. This MUST
// equal DATA_MUTATING_STEP_KINDS (componentSpecs.js); a kind the server knows
// but this set omits falls through execStep's `default: return` and becomes a
// SILENT no-op — the surrounding sequence keeps running and still reports
// success. `send_email` was missing here and did exactly that: the support desk
// toasted "Reply sent" while nothing was ever sent. useActionRunner.stepKinds
// .test.js now pins the two lists together.
// MUST equal DATA_MUTATING_STEP_KINDS (componentSpecs.js). ai_browse is in the
// set for that invariant, but execStep intercepts it FIRST (it streams over a
// dedicated SSE endpoint, not the plain JSON /step dispatch) — the generic
// branch below never sees it.
export const SERVER_STEP_KINDS = new Set(['run_automation', 'create_record', 'update_record', 'delete_record', 'request_approval', 'ai_extract', 'ai_generate', 'kb_query', 'send_email', 'generate_file', 'fill_document', 'generate_presentation', 'redact_pdf', 'file_intake', 'dataset_query', 'ai_browse']);

// A hard deadline on one server step. Deliberately longer than the server's own
// AI ceiling (STUDIO_APP_AI_TIMEOUT_MS, 120s) so a real server error still wins
// the race and the user gets the specific message rather than this generic one.
const STEP_DEADLINE_MS = 135_000;

// A browse holds a browser slot far longer than a data step. Deadline sits
// ABOVE the server's own 240s hard cap (routes/studioAppBrowse.js) so a
// specific server error still wins the race over this generic backstop.
const BROWSE_STEP_DEADLINE_MS = 250_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The effect keys this build knows how to apply. Anything else in an effect
// object is skipped — and said out loud (see applyEffects). Kept as an explicit
// ALLOW-LIST rather than a "skip the ones I don't like" list so a key added on
// the server side shows up as an unknown here instead of being applied by
// accident through a generic loop.
const KNOWN_EFFECT_KEYS = new Set(['toast', 'navigateTo', 'refresh', 'onError']);

/**
 * The effect object to apply after a run: what the ROUTINE returned
 * (`_appEffects` from a return_to_app step) laid over what the app AUTHOR
 * wrote on the action. Per key, so an author's toast survives a routine that
 * only asked for a navigation.
 */
function mergeAppEffects(authored, fromRun) {
    if (!fromRun || typeof fromRun !== 'object' || Array.isArray(fromRun)) return authored;
    return { ...(authored && typeof authored === 'object' ? authored : {}), ...fromRun };
}

function showToast(tone, message) {
    if (!message) return;
    if (tone === 'success') toast.success(message);
    else if (tone === 'danger') toast.error(message);
    else toast.info(message); // 'info' and 'warning' share the info style
}

/**
 * "De routine is klaar, maar dit lukte hier niet." Eén plek, zodat elke soort
 * mislukking dezelfde weg naar buiten neemt: `onError:'errorScreen'` zegt het
 * hardop tegen de bezoeker, `stay` (de versmallende default, en ook wat een
 * ONBEKENDE onError oplevert) laat een regel in de console achter.
 */
function reportEffectFailures(failures, onError) {
    if (!failures.length) return;
    const message = `The routine finished, but ${failures.join(' and ')}.`;
    if (onError === 'errorScreen') showToast('danger', message);
    else console.warn(`[AppStudio] ${message}`);
}

// A bare v1 action is an implicit 1-step sequence; a v2 action carries its steps.
function normalizeSequence(action) {
    if (!action || typeof action !== 'object') return [];
    if (action.kind === 'sequence') return Array.isArray(action.steps) ? action.steps : [];
    return [action];
}

// Pre-order flatten — BYTE-IDENTICAL to the server's flattenSteps
// (routes/studioAppsRun.js) so a step's ordinal here is the same one the server
// resolves from the definition. Returns a Map(step → index).
function buildStepIndexMap(steps) {
    const map = new Map();
    let i = 0;
    const walk = (list) => {
        for (const step of (Array.isArray(list) ? list : [])) {
            if (!step || typeof step !== 'object') continue;
            map.set(step, i++);
            if (step.kind === 'condition') { walk(step.then); walk(step.else); }
            else if (step.kind === 'loop') { walk(step.steps); }
            else if (step.kind === 'switch') {
                for (const c of (Array.isArray(step.cases) ? step.cases : [])) {
                    if (c && typeof c === 'object') walk(c.steps);
                }
                walk(step.default);
            }
        }
    };
    walk(steps);
    return map;
}

function sequenceHasServerStep(steps) {
    for (const [step] of buildStepIndexMap(steps)) {
        if (step && SERVER_STEP_KINDS.has(step.kind)) return true;
    }
    return false;
}

// Loose switch-case match: tolerate a number-vs-string authoring mismatch.
function caseMatches(caseValue, exprValue) {
    if (caseValue === exprValue) return true;
    if (caseValue == null || exprValue == null) return false;
    return String(caseValue) === String(exprValue);
}

// Distinct copy for a server step rejected by the storage quota (the server
// marks it with code:'quota_exceeded' — 409 body or step-result body alike).
const QUOTA_TOAST = 'Storage limit reached — delete rows or attachments to continue';

// Resolve a navigate action/step's optional params map against the live scope:
// { key: {kind:'static',value} | {kind:'formula',expr} } → { key: value }.
function resolveNavParams(params, scope) {
    if (!params || typeof params !== 'object') return {};
    const out = {};
    for (const [key, entry] of Object.entries(params)) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.kind === 'static') out[key] = entry.value;
        else if (entry.kind === 'formula') out[key] = tryEvaluate(entry.expr, scope).value;
    }
    return out;
}

function defaultConfirm(step) {
    const message = (step && step.message) || 'Are you sure?';
    if (typeof window === 'undefined') return Promise.resolve(true);
    // eslint-disable-next-line no-restricted-properties -- the default when no host mounts a dialog
    try { return Promise.resolve(window.confirm(message)); } catch { return Promise.resolve(true); }
}

export default function useActionRunner(appId, definition, {
    draft = false, onNavigate, confirm, onRefresh, currentUser = null, dataState = null,
    // The two scope roots the RENDERER always has and the runner did not:
    // `forms` (every form's live values, by node id) and `screen`
    // ({ id, name, params }). A step formula reading screen.params.<name> —
    // how every template hands a record id to a detail screen — resolved to
    // undefined, so the delete button on a detail screen deleted nothing.
    // Optional: a caller that omits them gets the empty objects buildScope
    // already defaults to.
    forms = null, screen = null,
    /**
     * Awaited once before a sequence that touches the SERVER runs.
     *
     * `stepIndex` is never stored: the browser derives it from the definition
     * it holds and the server from the one it has (?draft=1 → the SAVED draft).
     * In the editor those are not the same document — autosave is debounced —
     * so previewing an action inside that window had the server resolve the
     * ordinal to a DIFFERENT step than the one on screen. On a delete_record
     * that is not a cosmetic difference. The editor passes its autosave flush;
     * a caller with nothing to flush passes nothing.
     * → { ok:false } aborts the run rather than dispatching against a draft the
     * server has not got.
     */
    beforeServerStep = null,
    /**
     * onBrowseEvent(actionId, evt) — the live-browse frame sink. An ai_browse
     * step streams screenshot/action events over its own SSE endpoint; the
     * runner forwards each to this callback (RunSurface wires it to the
     * BrowserRunContext store so a browser_view can render it). Omitted → the
     * step still runs, just without a live preview.
     */
    onBrowseEvent = null,
} = {}) {
    const [actionState, setActionState] = useState({});
    // Shared variable state for the whole run surface — sequences seed their
    // local vars from it and merge set_variable/resultVar writes back in.
    //
    // SEEDED from definition.variables, so a records binding filtered on
    // `vars.status` filters on the FIRST paint instead of being dropped for
    // having no value yet (resolveBindingFilters omits an unresolved entry).
    const [vars, setVars] = useState(() => seedVariableDefaults(definition?.variables));

    // Refs so runAction stays identity-stable but never reads stale data.
    const stateRef = useRef(actionState);
    stateRef.current = actionState;
    const varsRef = useRef(vars);
    varsRef.current = vars;
    const definitionRef = useRef(definition);
    definitionRef.current = definition;
    const onNavigateRef = useRef(onNavigate);
    onNavigateRef.current = onNavigate;
    const onBrowseEventRef = useRef(onBrowseEvent);
    onBrowseEventRef.current = onBrowseEvent;
    const confirmRef = useRef(confirm);
    confirmRef.current = confirm;
    const onRefreshRef = useRef(onRefresh);
    onRefreshRef.current = onRefresh;
    const currentUserRef = useRef(currentUser);
    currentUserRef.current = currentUser;
    const dataStateRef = useRef(dataState);
    dataStateRef.current = dataState;
    const formsRef = useRef(forms);
    formsRef.current = forms;
    const screenRef = useRef(screen);
    screenRef.current = screen;
    const beforeServerStepRef = useRef(beforeServerStep);
    beforeServerStepRef.current = beforeServerStep;
    /*
     * Fold a change in the DECLARATIONS into the live bag.
     *
     * The trap here is specific: Canvas.jsx passes the live editor definition,
     * which is a NEW object on every inspector keystroke. An effect keyed on
     * `definition` would re-seed — wiping vars.filters mid-typing and resetting
     * preview state on every character. So the effect is keyed on a signature of
     * the DECLARATIONS only; definitionOps preserves structural sharing, so
     * `definition.variables` keeps its reference across every edit that is not a
     * variables edit and the memo never even recomputes.
     */
    const declSignature = useMemo(
        () => JSON.stringify((definition?.variables || []).map((v) => [v.name, v.type, v.default])),
        [definition?.variables],
    );
    // Initialised to the same list the lazy useState seeded from, so the first
    // pass is a no-op rather than a reconcile against nothing.
    const prevDeclsRef = useRef(definition?.variables || []);
    // Keyed on the signature, NOT on `definition` — see above.
    const reconcileDecls = useEffectEvent(() => {
        const next = definition?.variables || [];
        setVars((prev) => reconcileVariableDefaults(prev, prevDeclsRef.current, next));
        prevDeclsRef.current = next;
    });
    useEffect(() => { reconcileDecls(); }, [declSignature]);

    const aliveRef = useRef(true);
    useEffect(() => {
        aliveRef.current = true;
        return () => { aliveRef.current = false; };
    }, []);

    const setEntry = useCallback((actionId, entry) => {
        if (!aliveRef.current) return;
        setActionState((prev) => ({ ...prev, [actionId]: entry }));
    }, []);

    // Public writer (filter_bar etc.) AND the merge target for sequence writes.
    //
    // Writing the SAME value used to allocate a new `vars` object anyway, and
    // that object is what the run surface memoises its scope on: a no-op write
    // re-stamped the scope, re-rendered every node on the screen and re-resolved
    // every binding. Sequences do this constantly — clicking the row you already
    // had open sets two dozen variables to the values they already hold. Bail out
    // on an unchanged primitive so nothing downstream wakes up. Objects and
    // arrays still pass through: they are rebuilt per run and comparing them by
    // identity would report "changed" every time regardless.
    const setVar = useCallback((name, value) => {
        if (!aliveRef.current || typeof name !== 'string' || !name) return;
        setVars((prev) => (Object.is(prev[name], value) && name in prev
            ? prev
            : { ...prev, [name]: value }));
    }, []);

    /**
     * Apply an EFFECT OBJECT — "what happens when the action is done".
     *
     * Two sources, one shape. The app author writes `action.onSuccess` /
     * `action.onError` in the inspector; a routine writes the same shape from
     * a `return_to_app` step and it reaches here as `_appEffects` on the run
     * result. The routine's keys are merged OVER the author's at the call
     * sites: it knows what actually happened, the author only knew what was
     * intended.
     *
     * ── NIETS VERDWIJNT STIL ────────────────────────────────────────────────
     * Twee soorten "dit lukt niet", en allebei worden ze gemeld:
     *   1. EEN EFFECT DAT DEZE APP NIET KENT. Een routine kan nieuwer zijn dan
     *      het app-bundel dat hem draait. Onbekende sleutels worden overgeslagen
     *      — nooit een crash, en nooit ten koste van de sleutels die we WEL
     *      kennen — maar er gaat een regel naar de console. De serverkant heeft
     *      op dat moment al vastgelegd wat hij verstuurde (de `return_to_app`-
     *      stap schrijft `_appEffects` én `_ignored` in zijn eigen runregel), dus
     *      "wat heeft de routine gevraagd" is altijd na te lezen in het runlog.
     *   2. EEN EFFECT DAT HIER NIET UITVOERBAAR IS — een scherm dat deze app
     *      niet heeft, of `resetForm` terwijl er geen formulier is dat de actie
     *      startte. Dan beslist `onError`: `stay` laat de bezoeker staan waar
     *      hij staat (de versmallende default), `errorScreen` zegt het hardop.
     *
     * `errorScreen` toont vandaag een danger-melding en navigeert niet: App
     * Studio kent nog geen apart foutscherm, en naar een scherm springen dat we
     * moeten RADEN is precies de fout die deze tak moet opvangen. Zodra een app
     * er wél een aanwijst, is dit de plek.
     */
    const applyEffects = useCallback(async (effects, ctx = {}) => {
        // Reasons the return could not be carried out here, in the visitor's
        // words. Collected rather than thrown: a screen that no longer exists
        // must not swallow the toast that explains what just happened.
        const failures = [];

        // DE DERDE STAND VAN DE SERVER. `_appEffectsUnknown` betekent: de run
        // slaagde, maar de stappenlees waaruit `_appEffects` komt viel om
        // (server/appStudio/actionExecutor/automationBridge.js). Zonder deze
        // regel is dat antwoord niet te onderscheiden van "deze routine had
        // geen terugkeerstap": geen melding, geen navigatie, geen spoor. Dit
        // staat vóór de `!effects`-uitgang, want juist in dat geval is er
        // niets anders dat het zegt.
        if (ctx.effectsUnknown) {
            failures.push('what the routine asked the app to do next could not be read');
        }

        if (!effects || typeof effects !== 'object') {
            if (failures.length) reportEffectFailures(failures, null);
            return;
        }
        const unknown = Object.keys(effects).filter((k) => !KNOWN_EFFECT_KEYS.has(k));
        if (unknown.length) {
            console.warn(
                `[AppStudio] The routine asked for ${unknown.map((k) => `"${k}"`).join(', ')}, `
                + 'which this version of the app cannot do — ignored. The run log records what it sent.',
            );
        }

        if (effects.toast && effects.toast.message) showToast(effects.toast.tone, effects.toast.message);

        // `navigateTo` has two shapes and both stay supported: the STRING an
        // authored onSuccess effect has always carried, and the OBJECT a
        // return_to_app step produces ({ screenId, params }) so the next screen
        // can open one record.
        const nav = effects.navigateTo;
        const screenId = typeof nav === 'string'
            ? nav
            : (nav && typeof nav === 'object' ? nav.screenId : null);
        if (screenId) {
            const screens = definitionRef.current?.screens;
            // Geen lijst = niet controleerbaar, en dan blijft het gedrag zoals
            // het was. Alleen een lijst die het scherm AANTOONBAAR niet bevat
            // is een mislukking; anders zou een app zonder screens-array niet
            // meer kunnen navigeren.
            const missing = Array.isArray(screens) && !screens.some((sc) => sc && sc.id === screenId);
            if (missing) failures.push(`the screen “${screenId}” is not part of this app`);
            else if (onNavigateRef.current) {
                // Zonder params exact de aanroep die hier altijd al stond
                // (één argument). Een tweede argument dat `undefined` is,
                // gedraagt zich hetzelfde maar verandert wel wat elke
                // meelezende test en elke onNavigate-implementatie te zien
                // krijgt — en dat is een verandering zonder reden.
                const params = (nav && typeof nav === 'object') ? nav.params : null;
                if (params) onNavigateRef.current(screenId, params);
                else onNavigateRef.current(screenId);
            }
        }

        // `refresh` is een GESLOTEN vocabulaire
        // (validate/constants.js RETURN_TO_APP_REFRESH_MODES), en een gesloten
        // vocabulaire dat als DATA reist heeft een afsluitende tak nodig: deze
        // app-bundel kan ouder zijn dan de routine die hem aanstuurt.
        // KNOWN_EFFECT_KEYS vangt een onbekende SLEUTEL; zonder de `else`
        // hieronder viel een onbekende WAARDE van een bekende sleutel stil weg.
        if (effects.refresh === 'tableViews') {
            // Symmetrisch met resetForm: is er geen databron die zich heeft
            // aangemeld, dan is dat een mislukking en geen non-actie. Zonder
            // deze regel gebeurde er niets en werd er ook niets gemeld.
            if (onRefreshRef.current) {
                try { await onRefreshRef.current(); } catch { failures.push('the data could not be reloaded'); }
            } else {
                failures.push('there is no data on this screen to reload');
            }
        } else if (effects.refresh === 'resetForm') {
            // Alleen het formulier dat DEZE actie startte. Alle formulieren op
            // het scherm legen zou ook de filterbalk wissen die de bezoeker
            // net had ingesteld.
            //
            // De bus is gekeyd op de form-NAAM (`props.name || node.id`, en
            // canonicalize garandeert dat `props.name` gevuld is), terwijl
            // AppForm zijn NODE-id als `formId` meestuurde. Die twee zijn dus
            // per definitie nooit gelijk, en `resetAppForm` doet stil niets
            // voor een onbekende naam — het formulier bleef ingevuld staan en
            // niemand hoorde er iets over. Vandaar `formName` als de sleutel,
            // met `formId` als terugval voor een formulier zonder naam.
            const formKey = (typeof ctx.formName === 'string' && ctx.formName)
                ? ctx.formName
                : ((typeof ctx.formId === 'string' && ctx.formId) ? ctx.formId : null);
            if (formKey) resetAppForm(formKey);
            else failures.push('there is no form here to clear');
        } else if (effects.refresh) {
            failures.push(`this app does not know how to refresh “${String(effects.refresh)}”`);
        }

        if (failures.length) reportEffectFailures(failures, effects.onError);
    }, []);

    const pollRun = useCallback(async (runId) => {
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
            await sleep(POLL_INTERVAL_MS);
            if (!aliveRef.current) throw CANCELLED;
            const res = await authFetch(
                `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/actions/runs/${encodeURIComponent(runId)}`,
            );
            let body = null;
            try { body = await res.json(); } catch { body = null; }
            if (!res.ok) throw new Error(body?.error || `Could not check the run (${res.status})`);
            const status = body?.status;
            if (status && !['pending', 'running', 'queued'].includes(status)) return body;
        }
        throw new Error('The routine is taking too long — check its run history.');
    }, [appId]);

    // ── v1 run_automation bridge (unchanged) ───────────────────────────────
    const runAutomationAction = useCallback(async (actionId, action, opts) => {
        if (stateRef.current[actionId]?.status === 'running') return;
        setEntry(actionId, { status: 'running', result: undefined, error: null });
        try {
            const qs = draft ? '?draft=1' : '';
            const res = await authFetch(
                `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/actions/${encodeURIComponent(actionId)}/run${qs}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ formValues: opts.formValues || {}, wait: true }),
                },
            );
            let body = null;
            try { body = await res.json(); } catch { body = null; }

            if (res.status === 202) {
                const runId = body?.runId ?? body?.id;
                if (runId != null) {
                    body = await pollRun(runId);
                } else if (body?.status === 'pending') {
                    // Accepted, but with no run id there is nothing to poll (a
                    // GET on `undefined` would 404 and report a failure the user
                    // never had). The routine keeps running server-side, so
                    // settle neutrally: no error state, no success/error effects.
                    setEntry(actionId, { status: 'idle', result: undefined, error: null });
                    showToast('info', 'The routine is still running — check its run history.');
                    return;
                } else {
                    throw new Error(body?.error || body?.message || 'The action was accepted but never returned a result.');
                }
            } else if (!res.ok) {
                throw new Error(body?.error || body?.message || `The action failed (${res.status})`);
            }
            if (body?.status === 'error') {
                throw new Error(body?.error || 'The action failed.');
            }
            if (body?.status === 'awaiting_approval') {
                // The routine paused on an approval step — working as designed,
                // not a success and certainly not a failure. Settle with the
                // handle (approvalId) but hold the onSuccess effects: nothing
                // has succeeded yet, someone still has to decide.
                setEntry(actionId, {
                    status: 'success',
                    result: body && body.result !== undefined ? body.result : body,
                    error: null,
                });
                showToast('info', 'Sent for approval — it continues once someone decides.');
                return;
            }
            setEntry(actionId, {
                status: 'success',
                result: body && body.result !== undefined ? body.result : body,
                error: null,
            });
            // `_appEffects` rides beside `output` on the run body — the same
            // field whether the run answered directly or through the poll, so
            // there is no second channel and nothing new to subscribe to.
            await applyEffects(mergeAppEffects(action.onSuccess, body?._appEffects), { formId: opts.formId, formName: opts.formName, effectsUnknown: !!body?._appEffectsUnknown });
        } catch (err) {
            if (err === CANCELLED || !aliveRef.current) return;
            const message = err?.message || 'The action failed.';
            setEntry(actionId, { status: 'error', result: undefined, error: message });
            // A bare v1 run_automation set actionState.error and stopped there —
            // and no runtime component renders that, so a failed action was
            // completely invisible. The sequence path has always toasted; this
            // is the same promise for the older shape.
            showToast('danger', message);
            await applyEffects(action.onError, { formId: opts.formId, formName: opts.formName });
        }
    }, [appId, draft, setEntry, applyEffects, pollRun]);

    // ── v2 sequence coordinator ────────────────────────────────────────────
    const runSequence = useCallback(async (actionId, action, opts) => {
        const steps = normalizeSequence(action);
        const indexMap = buildStepIndexMap(steps);
        const hasServer = sequenceHasServerStep(steps);

        // Only a server-touching sequence shows the triggering control's spinner
        // (and guards re-entry). Pure client sequences run synchronously.
        if (hasServer && stateRef.current[actionId]?.status === 'running') return;
        if (hasServer && beforeServerStepRef.current) {
            // The server resolves the step from the definition IT has; make
            // sure that is the one on screen before handing it an ordinal.
            const ready = await beforeServerStepRef.current();
            if (ready && ready.ok === false) {
                showToast('danger', ready.error || 'Your latest changes could not be saved, so this was not run.');
                return;
            }
        }
        if (hasServer) setEntry(actionId, { status: 'running', result: undefined, error: null });

        const state = {
            actionId,
            formValues: opts.formValues || {},
            vars: { ...varsRef.current },
            // The ROW that triggered this, when one did. A row click hands the
            // row over, and the inspector's own picker (and every template)
            // teaches `item.<field>` for it — so without this, "open THIS
            // ticket" resolved to undefined and the next screen opened blank.
            // A loop step overwrites both for the duration of its body.
            item: opts.item,
            index: opts.index,
            // The VALUE beside the row, when the trigger carries one — a kanban
            // drop's target column, an onChange's new value. `value` has been a
            // declared scope root on both sides all along, but nothing ever put
            // the payload's value into it, so `expr: 'value'` always read
            // undefined while `form.value` worked.
            value: opts.value,
            lastResult: undefined,
            // What a return_to_app step handed back, collected across the whole
            // sequence and applied once at the end.
            appEffects: null,
            error: null,
        };

        // The FULL bag resolveBinding takes ({ actionState, dataState, scope }) —
        // identical to the one the renderer builds. A scope-only bag makes every
        // record/records/dataset/connector/actionResult source resolve to
        // undefined (a loop over a table would run zero iterations).
        const liveBag = (st) => {
            const merged = { ...stateRef.current };
            if (st.lastResult !== undefined) {
                merged[actionId] = { status: 'running', result: st.lastResult, error: null };
            }
            const data = dataStateRef.current || {};
            return {
                actionState: merged,
                dataState: data,
                scope: buildScope({
                    actionState: merged,
                    dataState: data,
                    form: st.formValues || {},
                    // `forms` and `screen` are in every scope the RENDERER
                    // builds, so a formula that reads screen.params.<name> —
                    // which is how every template passes a record id to a detail
                    // screen — worked in a binding and resolved to undefined in
                    // the step that acted on it.
                    forms: formsRef.current || {},
                    screen: screenRef.current || {},
                    vars: st.vars || {},
                    item: st.item,
                    index: st.index,
                    value: st.value,
                    currentUser: currentUserRef.current || null,
                }),
            };
        };

        const liveScope = (st) => liveBag(st).scope;

        const dispatchServerStep = async (step, st) => {
            const stepIndex = indexMap.get(step);
            const body = { stepIndex, formValues: st.formValues || {}, vars: st.vars || {} };
            if (st.item !== undefined) body.item = st.item;
            // `index` is a declared server scope root and the loop tracks it,
            // but it was never put in the body: a create_record inside a loop
            // whose column read `index + 1` wrote NaN into every row, while the
            // loop itself iterated perfectly.
            if (st.index !== undefined) body.index = st.index;
            // `value` rides along like item/index — it too is a declared server
            // scope root that otherwise arrives undefined in every server step.
            if (st.value !== undefined) body.value = st.value;
            const qs = draft ? '?draft=1' : '';
            let res;
            try {
                res = await authFetch(
                    `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/actions/${encodeURIComponent(actionId)}/step${qs}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                        // Longer than the server's own AI ceiling, so its message
                        // wins when it has one. This is the backstop for the case
                        // where it does not: a provider adapter that ignores
                        // timeoutMs would otherwise leave the spinner up forever.
                        signal: AbortSignal.timeout(STEP_DEADLINE_MS),
                    },
                );
            } catch (err) {
                if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
                    throw new Error('That took too long and was stopped. Try again, or with fewer documents.');
                }
                throw err;
            }
            let payload = null;
            try { payload = await res.json(); } catch { payload = null; }
            // A quota rejection (409 body or ok:false step result) gets its
            // own actionable copy instead of the raw server error.
            if (payload?.code === 'quota_exceeded') throw new Error(QUOTA_TOAST);
            if (!res.ok) throw new Error(payload?.error || `The step failed (${res.status})`);
            if (payload && payload.ok === false) throw new Error(payload.error || 'The step failed.');
            return payload && payload.result !== undefined ? payload.result : payload;
        };

        // ai_browse streams from its OWN endpoint: a browser agent runs
        // server-side and pushes screenshot/action events, which we forward to
        // the live-preview store. The resultVar is resolved from the terminal
        // {type:'result'} frame, exactly like a plain /step result.
        const dispatchBrowseStep = async (step, st) => {
            const stepIndex = indexMap.get(step);
            const body = { stepIndex, formValues: st.formValues || {}, vars: st.vars || {} };
            if (st.item !== undefined) body.item = st.item;
            if (st.index !== undefined) body.index = st.index;
            if (st.value !== undefined) body.value = st.value;
            const qs = draft ? '?draft=1' : '';
            const publish = onBrowseEventRef.current;
            if (publish) publish(actionId, { type: 'reset' });

            let res;
            try {
                res = await authFetch(
                    `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/actions/${encodeURIComponent(actionId)}/step/stream${qs}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                        // Above the server's 240s hard cap, so a specific server
                        // error wins the race over this generic backstop.
                        signal: AbortSignal.timeout(BROWSE_STEP_DEADLINE_MS),
                    },
                );
            } catch (err) {
                if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
                    throw new Error('The browse took too long and was stopped.');
                }
                throw err;
            }
            if (!res.ok || !res.body) {
                let payload = null;
                try { payload = await res.json(); } catch { /* not JSON */ }
                throw new Error(payload?.error || `The browse step failed (${res.status})`);
            }

            let final = null;
            let failed = null;
            await parseSseStream(res, (evt) => {
                if (evt.type === 'result') {
                    if (evt.ok) final = evt.result || {};
                    else failed = evt.error || 'The browse step failed.';
                } else if (evt.type !== 'done' && evt.type !== 'ping' && publish) {
                    publish(actionId, evt);
                }
            });
            if (failed) throw new Error(failed);
            return final || {};
        };

        const execStep = async (step, st) => {
            if (!step || typeof step.kind !== 'string') return;
            // ai_browse is a SERVER kind but streams — it takes the dedicated
            // SSE path, not the plain JSON /step dispatch below.
            if (step.kind === 'ai_browse') {
                const result = await dispatchBrowseStep(step, st);
                st.lastResult = result;
                if (typeof step.resultVar === 'string' && step.resultVar) {
                    st.vars = { ...st.vars, [step.resultVar]: result };
                    setVar(step.resultVar, result);
                }
                if (hasServer) setEntry(actionId, { status: 'running', result, error: null });
                return;
            }
            // Server kinds are dispatched from the SET, not from a hand-written
            // case list. The list-and-set used to be maintained separately and
            // drifted (send_email), which turns a step into a silent no-op
            // instead of an error. Driving both off one value makes that class
            // of bug unrepresentable.
            if (SERVER_STEP_KINDS.has(step.kind)) {
                const result = await dispatchServerStep(step, st);
                st.lastResult = result;
                // A run_automation STEP carries the routine's return the same
                // way the bare v1 action does. Held until the sequence is done
                // rather than applied here: navigating away halfway would abort
                // the steps that still had to run.
                if (result && typeof result === 'object' && result._appEffects) {
                    st.appEffects = mergeAppEffects(st.appEffects, result._appEffects);
                }
                // Zie applyEffects: onleesbaar is niet hetzelfde als leeg. Eén
                // stap die het niet kon lezen kleurt de hele sequence, want de
                // instructies van die stap zijn dan echt weg.
                if (result && typeof result === 'object' && result._appEffectsUnknown) st.effectsUnknown = true;
                if (typeof step.resultVar === 'string' && step.resultVar) {
                    st.vars = { ...st.vars, [step.resultVar]: result };
                    setVar(step.resultVar, result); // persist beyond this sequence
                }
                if (hasServer) setEntry(actionId, { status: 'running', result, error: null });
                return;
            }
            switch (step.kind) {
                case 'navigate':
                    if (onNavigateRef.current) {
                        onNavigateRef.current(step.screenId, resolveNavParams(step.params, liveScope(st)));
                    }
                    return;
                case 'toast':
                    showToast(step.tone, step.message);
                    return;
                case 'open_url': {
                    const url = String(step.url || '').trim();
                    if (url.toLowerCase().startsWith('https://')) {
                        window.open(url, step.newTab === false ? '_self' : '_blank', 'noopener,noreferrer');
                    }
                    return;
                }
                case 'open_modal':
                    if (step.modalId) openAppModal(step.modalId);
                    return;
                case 'close_modal':
                    if (step.modalId) closeAppModal(step.modalId);
                    return;
                case 'reset_form':
                    if (typeof step.form === 'string' && step.form) resetAppForm(step.form);
                    return;
                case 'download_file': {
                    // Client-side on purpose: the bytes go straight to the
                    // user's disk and never through the action's result, so a
                    // generated CSV needs no file_preview parked on the screen
                    // to be reachable. Same attachment route file_preview
                    // fetches, so the viewer's access is checked identically.
                    const { value: entry } = resolveBinding(step.file, liveBag(st));
                    if (!entry || typeof entry !== 'object' || !entry.fileId) return;
                    const { value: nameOverride } = step.fileName
                        ? resolveBinding(step.fileName, liveBag(st))
                        : { value: null };
                    const name = String(nameOverride || entry.name || 'download').trim() || 'download';
                    const href = `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/attachments/${encodeURIComponent(entry.fileId)}`;
                    // authFetch, not a bare <a href>: the route is authenticated,
                    // and a plain link would navigate to a 401 instead of saving.
                    const res = await authFetch(href);
                    if (!res.ok) {
                        toast.error('That file could not be downloaded.');
                        return;
                    }
                    const blob = await res.blob();
                    const objectUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = objectUrl;
                    a.download = name;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                    // Revoked on the next tick: revoking synchronously races the
                    // browser's own read of the blob in Safari.
                    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
                    return;
                }
                case 'confirm': {
                    const ask = confirmRef.current || defaultConfirm;
                    const ok = await ask(step);
                    if (!ok) throw SEQ_ABORT;
                    return;
                }
                case 'set_variable': {
                    if (typeof step.name === 'string' && step.name) {
                        const { value } = resolveBinding(step.value, liveBag(st));
                        st.vars = { ...st.vars, [step.name]: value };
                        setVar(step.name, value); // persist beyond this sequence
                    }
                    return;
                }
                case 'refresh':
                    // Narrow to the source that changed when the author said
                    // which one. Passing nothing keeps the original "reload
                    // everything" behaviour, which is what a v2.0 definition
                    // (whose only field was the ignored actionId) still gets.
                    if (onRefreshRef.current) {
                        // AWAITED on purpose. Fire-and-forget made "refresh, then
                        // read what I just wrote" a race the read always lost:
                        // a loop over rows an earlier step created resolved its
                        // source against the stale cache and ran zero times. The
                        // only reliable workaround was to split such a flow over
                        // two button presses and let the human be the barrier.
                        // invalidateQueries resolves once the refetch has landed;
                        // the extra macrotask lets React commit the new data so
                        // dataStateRef.current is the fresh one by the next step.
                        await onRefreshRef.current(
                            (step.tableId || step.datasetId)
                                ? { tableId: step.tableId || null, datasetId: step.datasetId || null }
                                : undefined,
                        );
                        await new Promise((resolve) => { setTimeout(resolve, 0); });
                    }
                    return;
                case 'condition': {
                    const { value } = tryEvaluate(step.expr, liveScope(st));
                    await execSteps(value ? step.then : step.else, st);
                    return;
                }
                case 'switch': {
                    const { value } = tryEvaluate(step.expr, liveScope(st));
                    const cases = Array.isArray(step.cases) ? step.cases : [];
                    const hit = cases.find((c) => c && caseMatches(c.value, value));
                    await execSteps(hit ? hit.steps : step.default, st);
                    return;
                }
                case 'loop': {
                    const { value: src } = resolveBinding(step.source, liveBag(st));
                    const arr = Array.isArray(src) ? src : [];
                    const cap = Number.isInteger(step.maxIterations)
                        ? Math.min(step.maxIterations, MAX_LOOP_ITERATIONS) : MAX_LOOP_ITERATIONS;
                    for (let i = 0; i < arr.length && i < cap; i++) {
                        const outerVars = st.vars || {};
                        const iter = {
                            ...st,
                            item: arr[i],
                            index: i,
                            vars: {
                                ...outerVars,
                                ...(step.itemVar ? { [step.itemVar]: arr[i] } : {}),
                                ...(step.indexVar ? { [step.indexVar]: i } : {}),
                            },
                        };
                        await execSteps(step.steps, iter);
                        // itemVar/indexVar are ITERATION-scoped: whatever the name
                        // held outside the loop is restored, so later steps never
                        // see it pinned to the last row. Other writes carry on.
                        const carried = { ...iter.vars };
                        for (const name of [step.itemVar, step.indexVar]) {
                            if (typeof name !== 'string' || !name) continue;
                            if (Object.prototype.hasOwnProperty.call(outerVars, name)) carried[name] = outerVars[name];
                            else delete carried[name];
                        }
                        st.vars = carried;
                        st.lastResult = iter.lastResult;
                        // Same reason lastResult is carried back: an iteration
                        // is a copy of the state, so a routine's return picked
                        // up inside the body would otherwise be dropped.
                        if (iter.appEffects) st.appEffects = mergeAppEffects(st.appEffects, iter.appEffects);
                        if (iter.effectsUnknown) st.effectsUnknown = true;
                    }
                    return;
                }
                default:
                    return;
            }
        };

        const execSteps = async (list, st) => {
            for (const step of (Array.isArray(list) ? list : [])) {
                if (!aliveRef.current) throw CANCELLED;
                try {
                    await execStep(step, st);
                } catch (e) {
                    if (e === SEQ_ABORT || e === CANCELLED) throw e;
                    // A failure: run the step's optional onError branch (which
                    // handles it, then unwinds), else propagate up to abort.
                    if (step && Array.isArray(step.onError) && step.onError.length) {
                        await execSteps(step.onError, st);
                        throw SEQ_ABORT;
                    }
                    st.error = e?.message || 'The action failed.';
                    throw e;
                }
            }
        };

        try {
            await execSteps(steps, state);
            if (hasServer) setEntry(actionId, { status: 'success', result: state.lastResult, error: null });
            await applyEffects(mergeAppEffects(action.onSuccess, state.appEffects), { formId: opts.formId, formName: opts.formName, effectsUnknown: !!state.effectsUnknown });
        } catch (e) {
            if (e === SEQ_ABORT) {
                // Declined confirm / handled onError — settle without an error.
                if (hasServer) {
                    setEntry(actionId, state.lastResult !== undefined
                        ? { status: 'success', result: state.lastResult, error: null }
                        : { status: 'idle', result: undefined, error: null });
                }
                return;
            }
            if (e === CANCELLED || !aliveRef.current) return;
            const message = state.error || e?.message || 'The action failed.';
            // A server-touching sequence surfaces the error on the triggering
            // control (status:'error'); every failed sequence also toasts so the
            // abort is never silent. onError effects (if any) apply afterwards.
            if (hasServer) setEntry(actionId, { status: 'error', result: undefined, error: message });
            showToast('danger', message);
            await applyEffects(action.onError, { formId: opts.formId, formName: opts.formName });
        }
    }, [appId, draft, setEntry, setVar, applyEffects]);

    const runAction = useCallback(async (actionId, opts = {}) => {
        const action = definitionRef.current?.actions?.[actionId];
        if (!action) return;

        // v2 sequences use the coordinator; bare v1 actions keep their exact
        // legacy behaviour so existing call sites and semantics are unchanged.
        if (action.kind === 'sequence') {
            return runSequence(actionId, action, opts);
        }

        switch (action.kind) {
            case 'navigate':
                if (onNavigateRef.current) {
                    const scope = buildScope({
                        actionState: stateRef.current,
                        dataState: dataStateRef.current || {},
                        form: opts.formValues || {},
                        forms: formsRef.current || {},
                        screen: screenRef.current || {},
                        vars: varsRef.current || {},
                        item: opts.item,
                        index: opts.index,
                        value: opts.value,
                        currentUser: currentUserRef.current || null,
                    });
                    onNavigateRef.current(action.screenId, resolveNavParams(action.params, scope));
                }
                return;
            case 'toast':
                showToast(action.tone, action.message);
                return;
            case 'open_url': {
                const url = String(action.url || '').trim();
                if (!url.toLowerCase().startsWith('https://')) return;
                window.open(url, action.newTab === false ? '_self' : '_blank', 'noopener,noreferrer');
                return;
            }
            case 'open_modal':
                if (action.modalId) openAppModal(action.modalId);
                return;
            case 'close_modal':
                if (action.modalId) closeAppModal(action.modalId);
                return;
            case 'run_automation':
                return runAutomationAction(actionId, action, opts);
            // Native AI and email actions are server steps — run them through the
            // sequence coordinator (a bare action normalizes to a 1-step
            // sequence, which dispatches to /step and threads the result into
            // resultVar).
            // create_record joined this group when it became an ACTION kind as
            // well as a step kind ("add a row" is one of the four things a
            // button most often does). The /step endpoint resolves a bare
            // action through the same normalizeSequence the client uses, so it
            // needed no path of its own — only this one line. Without it, the
            // button was a silent no-op.
            case 'ai_extract':
            case 'ai_generate':
            case 'kb_query':
            case 'send_email':
            case 'create_record':
                return runSequence(actionId, action, opts);
            default: {
                // NEVER SILENT. This used to be `return`, so an action of a kind
                // this build has no case for did nothing at all: no request, no
                // toast, no error state. The control looked like it had worked
                // and the person went on believing the row was written.
                // useActionRunner.actionKinds.test.jsx drives every kind in the
                // server catalog through here and fails on silence.
                const message = `This app uses an action ("${action.kind}") this version cannot run. Update the app, or ask the person who built it.`;
                setEntry(actionId, { status: 'error', result: undefined, error: message });
                showToast('danger', message);
                return;
            }
        }
    }, [runSequence, runAutomationAction, setEntry]);

    return { actionState, runAction, vars, setVar };
}

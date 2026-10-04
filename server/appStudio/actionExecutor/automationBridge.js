/**
 * App Studio action executor — run_automation (extracted verbatim from
 * actionExecutor.js): the input bridge from viewer form values to automation
 * inputs, the typed app-trigger bridge (declared params, file expansion) and
 * the owner-scoped run itself.
 */

'use strict';

const studioAppDataStore = require('../../stores/studioAppDataStore');
const { LIMITS } = require('../componentSpecs');
const log = require('../../telemetry/log');

// Hygiene caps on viewer-supplied form values flowing into automation inputs
// (shared with routes/studioAppsRun.js, which also uses them for its own
// form/var bag sanitization).
const MAX_FIELD_KEY_LEN = 100;
const MAX_INPUT_FIELDS = 100;

// ── run_automation (owner-scoped) ───────────────────────────────────

/**
 * Resolve automation inputs from an inputMapping + viewer form values — the
 * ONLY bridge between the two. The SINGLE implementation shared by the /run
 * bridge (routes/studioAppsRun.js) and the run_automation sequence step here
 * (formerly two diverging copies; the stricter caps of the two won):
 *
 *   'static' → the author-authored literal, passed through.
 *   'field'  → one primitive pulled from formValues (objects/arrays throw a
 *              400 — the author mapped a scalar param). Strings are capped to
 *              LIMITS.MAX_STRING.
 *   omitted/empty mapping → ALL primitive form fields (the
 *              omitted-mapping-means-all-fields contract), capped at
 *              MAX_INPUT_FIELDS entries; non-primitives dropped silently.
 *
 * Keys longer than MAX_FIELD_KEY_LEN and unknown mapping kinds are dropped
 * silently — the validator rejects them at save time; a stale definition
 * shouldn't 500 here.
 */
function resolveInputs(inputMapping, formValues) {
    const values = (formValues && typeof formValues === 'object' && !Array.isArray(formValues)) ? formValues : {};
    const mapping = (inputMapping && typeof inputMapping === 'object' && !Array.isArray(inputMapping)) ? inputMapping : null;
    const inputs = {};

    const capString = (v) => (typeof v === 'string' ? v.slice(0, LIMITS.MAX_STRING) : v);

    if (mapping && Object.keys(mapping).length > 0) {
        for (const [param, m] of Object.entries(mapping)) {
            if (!m || typeof m !== 'object' || param.length > MAX_FIELD_KEY_LEN) continue;
            if (m.kind === 'static') {
                inputs[param] = m.value;
            } else if (m.kind === 'field') {
                const v = values[m.name];
                if (v === undefined || v === null) continue;
                const t = typeof v;
                if (t !== 'string' && t !== 'number' && t !== 'boolean') {
                    const err = new Error(`Field "${m.name}" must be a string, number or boolean`);
                    err.status = 400;
                    throw err;
                }
                inputs[param] = capString(v);
            }
        }
        return inputs;
    }

    // No mapping → all primitive form fields, non-primitives dropped silently.
    let count = 0;
    for (const [k, v] of Object.entries(values)) {
        if (count >= MAX_INPUT_FIELDS) break;
        if (k.length > MAX_FIELD_KEY_LEN) continue;
        const t = typeof v;
        if (v === null || (t !== 'string' && t !== 'number' && t !== 'boolean')) continue;
        inputs[k] = capString(v);
        count++;
    }
    return inputs;
}

// ── App-trigger typed bridge ────────────────────────────────────────

/** True when the target automation's PRIMARY trigger is an app trigger. */
function isAppTriggerAutomation(automation) {
    return require('../../automation/appTriggerContract').isAppTriggerDefinition(automation?.definition);
}

// Lifetime of the signed download URL handed to the automation for a `file`
// input. Long/paused runs (approvals) should fetch files early in the flow.
const FILE_URL_TTL_S = parseInt(process.env.STUDIO_APP_FILE_URL_TTL_S, 10) || 3600;

// A file param's expanded runtime value. mime/size ALWAYS come from the
// attachment LEDGER (never the client); `name` is the client's display name,
// sanitized. The url is an HMAC-signed, time-limited download the automation's
// steps (http_request / transcribe_audio / upload tools) can fetch — minted by
// tempDownloadUrl.generateTempDownloadUrl, which works in S3 and local-disk modes.
async function expandFileInput(param, descriptor, app) {
    const fail = (msg) => {
        const err = new Error(`Input "${param.name}" ${msg}`);
        err.status = 400;
        return err;
    };
    const attachment = await studioAppDataStore.getAttachment(descriptor.fileId, app.id, app.userId);
    // Owner-scoped lookup: a fileId from another app/owner resolves null.
    if (!attachment) throw fail('references a file that was not uploaded to this app');
    if (!attachment.scanned || attachment.quarantined) throw fail('references a file that has not passed the malware scan');

    const storageStore = require('../../stores/storageStore');
    const { generateTempDownloadUrl } = require('../../utils/tempDownloadUrl');
    const key = storageStore.buildStudioAppAttachmentKey(app.userId, app.id, attachment.sha256);
    const url = generateTempDownloadUrl(key, FILE_URL_TTL_S);

    const rawName = typeof descriptor.name === 'string' && descriptor.name.trim()
        ? descriptor.name.trim()
        : `attachment_${attachment.sha256.slice(0, 8)}`;
    return {
        fileId: attachment.id,
        name: rawName.slice(0, 200),
        mime: attachment.mimeType,
        size: attachment.size,
        url,
    };
}

/**
 * Resolve + validate the inputs for an APP-TRIGGER automation against its
 * declared `trigger.params` (contract: automation/appTriggerContract.js).
 * Unlike resolveInputs (the legacy primitive-only bridge, untouched), the
 * DECLARED CONTRACT is authoritative:
 *
 *   • per param: mapping 'static' → literal, 'field' → formValues[name];
 *     with NO mapping the param's own name indexes formValues (identity).
 *     Extra form fields that aren't declared params are never forwarded.
 *   • required params must be present — one 400 lists ALL missing names.
 *   • every value is type-checked/coerced (arrays/objects/JSON strings ok);
 *     `file` descriptors are verified against the attachment ledger and
 *     expanded to { fileId, name, mime, size, url }.
 *
 * Returns the FLAT validated inputs object (param names can't start with "_",
 * so the caller's audit keys can never be shadowed). Throws err.status=400
 * with a client-safe message on any violation.
 */
async function resolveAppTriggerInputs(automation, inputMapping, formValues, { app }) {
    const contract = require('../../automation/appTriggerContract');
    const params = contract.appTriggerParams(automation?.definition);
    const values = (formValues && typeof formValues === 'object' && !Array.isArray(formValues)) ? formValues : {};
    const mapping = (inputMapping && typeof inputMapping === 'object' && !Array.isArray(inputMapping)) ? inputMapping : null;

    const rawFor = (param) => {
        const m = mapping ? mapping[param.name] : null;
        if (m && typeof m === 'object') {
            if (m.kind === 'static') return m.value;
            if (m.kind === 'field') return values[m.name];
            return undefined; // unknown mapping kind — validator rejects at save time
        }
        return values[param.name]; // identity mapping by declared name
    };

    // Absent = not provided at all, or an empty form field. An unfilled input
    // of ANY type reads as '' from the form layer, so '' is uniformly "missing"
    // (an optional param is then simply omitted from the payload).
    const isMissing = (v) => v === undefined || v === null || v === '';

    const missing = params.filter((p) => p.required && isMissing(rawFor(p)));
    if (missing.length > 0) {
        const err = new Error(`Missing required input${missing.length > 1 ? 's' : ''}: ${missing.map((p) => p.name).join(', ')}`);
        err.status = 400;
        throw err;
    }

    const inputs = {};
    for (const param of params) {
        const raw = rawFor(param);
        if (isMissing(raw)) continue; // optional + absent
        const checked = contract.checkInputValue(param.type, raw);
        if (!checked.ok) {
            const err = new Error(`Input "${param.name}" ${checked.error}`);
            err.status = 400;
            throw err;
        }
        inputs[param.name] = checked.isFile
            ? await expandFileInput(param, checked.descriptor, app)
            : checked.value;
    }
    return inputs;
}

/**
 * The automation's final value for the app's actionResult bindings — the SINGLE
 * implementation shared with routes/studioAppsRun.js (run + poll endpoints).
 *
 * executeAutomation resolves with the persisted run ROW, which carries no
 * output column (the engine's `lastOutput` never leaves runGraph), so
 * `run.output` is undefined on every normal path. Mirror the engine's
 * lastOutput contract instead: the output of the last executed TOP-LEVEL
 * step (child rows of loops/layers are skipped via parentStepId, and a `wait`
 * is never an answer — runDag defers waits to the end of a fan-out). Step
 * outputs are already redacted + truncated by recordRunStep, so this leaks
 * nothing the executions UI doesn't already show the run's owner.
 */
/**
 * Step types that are never a run's ANSWER.
 *
 *   trigger  — the input, not the result
 *   wait     — `{ waitedSeconds: 120 }` is bookkeeping (and runDag defers a
 *              wait to the end of a fan-out, which is what made it a candidate)
 *   return_to_app — its output is not data at all: it is the INSTRUCTION SET
 *              for the app (`_appEffects`). A return_to_app is by construction
 *              the LAST top-level step of the run, so without this line every
 *              existing `actionResult` binding in every app would silently stop
 *              reading the automation's data and start reading the effects object
 *              the moment someone added a return step. The effects travel in
 *              their own field — see deriveAppEffects below.
 *
 * Listed by hand rather than derived, for the reason DATATABLE_WRITE_OPS is:
 * a type added later must not become "the answer" by default.
 */
const NON_ANSWER_STEP_TYPES = new Set(['trigger', 'wait', 'return_to_app']);

/**
 * ONE pass over a run's steps, two answers: the value the app's actionResult
 * bindings read, and the instructions a `return_to_app` step left for the app.
 *
 * Both callers (routes/studioAppsRun's run + poll endpoints, and the
 * run_automation sequence step below) need both, and the run-step read is the
 * expensive half — so it happens once.
 */
/**
 * Is deze runregel een TOP-LEVEL stap van de hoofdgraaf?
 *
 * Twee velden, want de runner heeft twee manieren om te nesten en ze zetten
 * verschillende dingen:
 *
 *   parentStepId  gezet door execCallLayer/execCallBlock ('cl1/out' → 'cl1').
 *   branchIndex   gezet door execParallel: die draait de tak MÉT
 *                 `recordSteps:true` en laat `ctx.stepRecord` ongemoeid, dus
 *                 `parentStepId` blijft daar NULL. Op `parentStepId` alleen
 *                 telt een stap in een parallelle tak dus als top-level.
 *
 * (Een loop-body levert helemaal geen regels op: execLoop draait hem met
 * `recordSteps:false`. Er is dus niets om hier te herkennen — de validator
 * weigert een `return_to_app` daar sinds P4 hard, zie
 * validate/constants.js NESTED_FORBIDDEN_RULES.)
 */
function isTopLevelRow(s) {
    return !s.parentStepId && (s.branchIndex === null || s.branchIndex === undefined);
}

async function deriveRunOutcome(run) {
    if (!run) return { output: null, appEffects: null };
    if (run.output !== undefined) return { output: run.output ?? null, appEffects: null };
    if (run.status !== 'success') return { output: null, appEffects: null };
    try {
        const automationStore = require('../../stores/automationStore');
        const steps = await automationStore.getRunSteps(run.id);
        let output = null;
        for (let i = steps.length - 1; i >= 0; i--) {
            const s = steps[i];
            // BEWUST alleen `parentStepId`, niet isTopLevelRow: welke regel de
            // `actionResult`-bindingen van élke bestaande app lezen, is niet
            // iets om en passant te verschuiven. Die scan blijft byte-identiek.
            if (!s.parentStepId && !NON_ANSWER_STEP_TYPES.has(s.stepType)) { output = s.output ?? null; break; }
        }
        // De LAATSTE top-level return_to_app wint: een automatisering mag er één per
        // tak dragen, en er draaide er maar één.
        //
        // Genestelde regels tellen niet mee, en dat is hier een HARDERE eis dan
        // bij de output-scan hierboven. Een `return_to_app` hoort nergens
        // genesteld te staan — de validator weigert hem in een flowlet/Step
        // (`layer.return_to_app_forbidden`) én in een loop-body of parallelle
        // tak (`return_to_app.nested_forbidden`) — maar een definitie die vóór
        // die regels is opgeslagen, of met de hand geschreven, komt hier nog
        // steeds langs. En in een parallelle tak is dat niet onschuldig: de app
        // zou "we zijn klaar, ga hierheen" krijgen terwijl de andere takken en
        // alles ná de parallel nog draaien. Vandaar isTopLevelRow, dat óók naar
        // branchIndex kijkt.
        let appEffects = null;
        for (let i = steps.length - 1; i >= 0; i--) {
            const s = steps[i];
            if (!isTopLevelRow(s) || s.stepType !== 'return_to_app') continue;
            const eff = s.output && typeof s.output === 'object' ? s.output._appEffects : null;
            if (eff && typeof eff === 'object' && !Array.isArray(eff)) appEffects = eff;
            break;
        }
        return { output, appEffects };
    } catch (e) {
        // MISLUKT LEZEN IS GEEN "GEEN INSTRUCTIES".
        //
        // Zonder `effectsUnknown` is dit antwoord byte-identiek aan dat van een
        // automation zónder terugkeerstap: runBody laat `_appEffects` dan gewoon
        // weg en de bezoeker ziet niets gebeuren — geen toast, geen navigatie,
        // geen spoor. Voor `output` was dat bestaand gedrag; aan diezelfde
        // stille tak hangt sinds P4 een NIEUWE belofte, en die mag niet in
        // dezelfde stilte verdwijnen. De vlag reist mee naar de app, die er een
        // regel over zegt in plaats van niets te doen.
        log.error(`[ActionExecutor] output derivation failed for run ${run?.id}: ${e.message}`);
        return { output: null, appEffects: null, effectsUnknown: true };
    }
}

async function deriveFinalOutput(run) {
    return (await deriveRunOutcome(run)).output;
}

async function runAutomationStep(app, step, ctx) {
    const automationId = (typeof step.automationId === 'string' && step.automationId) ? step.automationId : null;
    if (!automationId) return { ok: false, error: 'Automation not found' };

    const automationStore = require('../../stores/automationStore');
    // The LIVE definition (handoff 5): the app button's typed inputs are read
    // from the same copy the run will execute.
    const { automationForRun } = require('../../core/automationRunner/definitionForRun');
    const automation = automationForRun(await automationStore.getAutomation(automationId), { mode: 'live' });
    if (!automation) return { ok: false, error: 'Automation not found' };
    // Owner-ownership check — a post-wiring transfer must never let the app run
    // someone else's automation acts-as-owner.
    if (automation.userId !== app.userId) {
        return { ok: false, error: 'Automation does not belong to the app owner' };
    }

    // app_trigger targets get the TYPED bridge (declared params, flat payload
    // → trigger.output.<name>); everything else keeps the legacy primitive-only
    // `inputs` nesting byte-identical. `triggerKind: 'studio_app'` stays the
    // runtime label in both cases — `app_trigger` is the DEFINITION's kind.
    const audit = { _viewerUserId: ctx.viewerId ?? null, _studioAppId: app.id, _stepKind: 'run_automation' };
    const triggerPayload = isAppTriggerAutomation(automation)
        ? { ...(await resolveAppTriggerInputs(automation, step.inputMapping, ctx.formValues, { app })), ...audit }
        : { inputs: resolveInputs(step.inputMapping, ctx.formValues), ...audit };
    const runner = require('../../core/automationRunner');
    const run = await runner.executeAutomation(automation, {
        triggerKind: 'studio_app',
        triggerPayload,
        mode: 'live',
    });

    if (run && run.status === 'cancelled' && /already running/i.test(run.error || '')) {
        return { ok: true, result: { runId: run.id, status: 'skipped', output: null } };
    }
    // A pause on an approval step is NOT a failure — it is the automation working
    // as designed. Hand the app its durable handle (approvalId) so a sequence
    // can store it, show it, or branch on `result.status` with a condition
    // step; before this the app got an abort and a danger toast.
    if (run && run.status === 'awaiting_approval') {
        let approvalId = null;
        if (run.awaitingStepId) {
            approvalId = (await automationStore.getApprovalForRunStep(run.id, run.awaitingStepId, { pendingOnly: true })
                .catch(() => null))?.id || null;
        }
        return { ok: true, result: { runId: run.id, status: 'awaiting_approval', approvalId, output: null } };
    }
    const { output, appEffects } = await deriveRunOutcome(run);
    if (run && run.status && run.status !== 'success') {
        return { ok: false, error: run.error || 'The automation did not finish successfully', result: { runId: run.id, status: run.status, output } };
    }
    // `_appEffects` rides on the STEP result too, not only on the v1 /run
    // response. Without this line a return_to_app worked on a bare
    // run_automation action and did nothing at all inside a sequence — the
    // same half-covered shape that made send_email a silent no-op.
    return { ok: true, result: { runId: run?.id ?? null, status: run?.status ?? null, output, ...(appEffects ? { _appEffects: appEffects } : {}) } };
}

module.exports = {
    MAX_FIELD_KEY_LEN,
    MAX_INPUT_FIELDS,
    resolveInputs,
    isAppTriggerAutomation,
    resolveAppTriggerInputs,
    deriveFinalOutput,
    deriveRunOutcome,
    runAutomationStep,
};

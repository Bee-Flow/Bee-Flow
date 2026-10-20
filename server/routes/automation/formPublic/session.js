// @typecheck
/**
 * The visitor's session on a multi-page form: the poll that reports working,
 * the next page, done or error (with a trail of step titles while the
 * automation works), and the download of a document the journey produced.
 */

const log = require('../../../telemetry/log');
const { sendStream } = require('../../../core/http/sendStream');
const automationStore = require('../../../stores/automationStore');
const storageStore = require('../../../stores/storageStore');
const { issueCsrf } = require('../../../auth/publicShareToken');
const { isFileField } = require('../../../automation/formTriggerContract');
const { contentDisposition } = require('../../../core/http/contentDisposition');
const { endingFrom } = require('../../../automation/formResult');
const { lostToConcurrency } = require('../../../automation/formQueue');
const { typicalSeconds } = require('../../../automation/formTypicalDuration');
const { privateHeaders, loadForm, loadSession, currentRunFor, journeyRunIds, pendingPageFor } = require('./access');
const { ipLimiter, sessionLimiter } = require('./limits');
const { friendly } = require('./friendly');

// ── Multi-page: the visitor's session ─────────────────

/**
 * Turn `download` fields into something the page can actually render.
 *
 * The author binds `fileId` to a `generate_document` step's output; here that
 * id becomes a filename, a type and a size, looked up against the runs of THIS
 * journey. A field whose file is missing or expired is DROPPED rather than
 * rendered as a dead button — the visitor gets a page without a download
 * instead of a page with one that 404s.
 *
 * No URL is added. The page knows its own token and session id and builds the
 * link itself, which keeps this working when the API lives on another origin.
 */
async function resolveDownloadFields(form, session) {
    const fields = Array.isArray(form?.fields) ? form.fields : [];
    // `download` saves the file, `notebook` opens it in Notebooks. Both name a
    // generated file by id and both are resolved the same way — a field whose
    // file is gone or expired is DROPPED, so neither renders as a button that
    // leads nowhere.
    if (!fields.some(isFileField)) return form;

    const runIds = await journeyRunIds(session);
    const resolved = [];
    for (const f of fields) {
        if (!isFileField(f)) { resolved.push(f); continue; }
        if (!f.fileId || runIds.length === 0) continue;
        const file = await automationStore.getGeneratedFileForRuns(f.fileId, runIds).catch(() => null);
        if (!file) continue;
        resolved.push({
            name: f.name,
            type: f.type,
            label: f.label,
            help: f.help,
            required: false,
            fileId: file.id,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.size,
        });
    }
    return { ...form, fields: resolved };
}

/**
 * Where the automation is RIGHT NOW, as a trail of titles: the flowlet it stepped
 * into, then the node inside it. `["3. Zoekwoord zoeken", "Zoekvolume ophalen"]`.
 *
 * A visitor who has just answered a question sits on a spinner for as long as
 * the next stretch takes — a web search, a model call, a document being
 * written. "Just a moment" for ninety seconds reads as broken; the step's own
 * name reads as progress.
 *
 * Sub-steps are recorded under their caller's id (`cl_x/ai_y`, nested for a
 * flowlet that calls a flowlet), which is exactly the path to walk: each
 * segment but the last is a call_layer whose `layerKey` names the graph the
 * next segment lives in.
 *
 * Alongside the trail goes the running flowlet's own one-line DESCRIPTION when
 * it has one ("Searches Google for a given term and lets AI analyse top-ranking
 * pages…"). A step name says where the automation is; the description says what it
 * is doing, which is the thing a visitor staring at a spinner actually wants.
 *
 * LABELS AND FLOWLET DESCRIPTIONS, and only the ones on the path. The form URL
 * is public and its visitor is anonymous, so nothing else about the automation
 * goes out here — no ids, no step types, no tool names, no counts, no outputs.
 * An author who puts something confidential in a step's NAME, or in a flowlet's
 * description, is publishing it to whoever holds the link. Note that flowlet
 * descriptions can be AI-GENERATED (the builder's "AI flowlet summaries"), so
 * that text is not necessarily something the author wrote and read.
 */
// A description is a one-liner by design; the cap is there because this is a
// public endpoint and nothing upstream forces it to stay one.
const PROGRESS_NOTE_MAX = 400;

function progressTrail(definition, steps) {
    const current = [...steps].reverse().find(s => s && s.status === 'running' && s.stepId);
    if (!current) return null;

    const trail = [];
    let note = null;
    let graph = definition;
    const segments = String(current.stepId).split('/');
    for (let i = 0; i < segments.length; i++) {
        const step = (graph?.steps || []).find(x => x && x.id === segments[i]);
        if (!step) break;
        const last = i === segments.length - 1;
        if (!last) {
            const layer = definition?.layers?.[step.layerKey] || null;
            if (step.label) trail.push(step.label);
            else if (layer?.title) trail.push(layer.title);
            if (!layer) break;
            // Deepest description wins — that flowlet is the one doing the
            // work. A flowlet without one keeps its caller's, which is still
            // a truthful account of what the visitor is waiting for.
            const described = typeof layer.description === 'string' ? layer.description.trim() : '';
            if (described) note = described.slice(0, PROGRESS_NOTE_MAX);
            graph = layer;
            continue;
        }
        // A flowlet's own "Return" node is plumbing, not a stage worth naming.
        if (step.type !== 'layer_output' && step.label) trail.push(step.label);
    }
    return trail.length ? { trail, note } : null;
}

/**
 * A `working` response. It carries the one aggregate figure a visitor may see
 * about the automation's history: how many seconds a stretch usually takes.
 * Only ever on `working`; a page, an ending or an error never gets it.
 */
async function workingResponse(automationId, extra = {}) {
    const typical = await typicalSeconds(automationId);
    return { state: 'working', ...extra, ...(typical ? { typicalSeconds: typical } : {}) };
}

async function pollSession(req, res) {
    privateHeaders(res);
    const found = await loadForm(req, res);
    if (!found) return undefined;
    const loaded = await loadSession(found, req.params.sid);
    if (!loaded) return res.status(404).json({ error: 'Not found' });
    if (loaded.expired) return res.json({ state: 'expired' });

    const { session } = loaded;
    await automationStore.touchFormSession(session.id).catch(() => {});

    // Queued behind other submissions, or the run row is not written yet.
    const automationId = found.automation.id;
    if (!session.runId) return res.json(await workingResponse(automationId));
    const run = await currentRunFor(session);
    if (!run) return res.json(await workingResponse(automationId));

    if (run.status === 'awaiting_form') {
        const pending = await pendingPageFor(session, run);
        // The run says it is paused but the step row has not landed yet —
        // a sub-second window the poll should simply retry through.
        if (!pending) return res.json(await workingResponse(automationId));
        return res.json({
            state: 'form',
            stepId: pending.stepId,
            form: await resolveDownloadFields(pending.form, session),
            csrf: issueCsrf(`${found.token}:${session.id}`),
            issuedAt: Date.now(),
        });
    }
    if (run.status === 'queued' || run.status === 'running' || run.status === 'awaiting_approval') {
        // awaiting_approval is a human the VISITOR cannot help with, so it
        // reads as "still working" rather than exposing the internal gate.
        const at = run.status === 'running'
            ? progressTrail(found.automation.definition || {}, await automationStore.getRunSteps(run.id))
            : null;
        return res.json(await workingResponse(automationId, {
            ...(at ? { progress: at.trail } : {}),
            ...(at?.note ? { progressNote: at.note } : {}),
        }));
    }
    if (run.status === 'success') {
        const steps = await automationStore.getRunSteps(run.id);
        const ending = endingFrom(steps);
        // The closing page is where a download usually lives — "here is the
        // document the automation just made".
        return res.json({ state: 'done', ending: ending ? await resolveDownloadFields(ending, session) : null });
    }
    // A run that lost the per-automation race did nothing at all, and
    // runQueued is backing off to try it again. Reporting that as a failure
    // would end the visitor's journey over a collision they never caused.
    if (lostToConcurrency(run)) return res.json(await workingResponse(automationId));
    // error / cancelled. Never surface run.error — it is written for the
    // owner's diagnostics and can carry upstream API detail.
    return res.json({ state: 'error' });
}

/**
 * Download a document THIS journey produced.
 *
 * The session is the credential. There is no signed URL and no bearer token:
 * the file must belong to a run of the journey the `:sid` covers, so a visitor
 * can fetch their own output and nothing else, and access lapses when the
 * session does. That is why the step returns a bare `fileId` rather than a URL
 * — a URL that worked without the session would be a second, weaker credential.
 *
 * Every miss is a 404, never a 403: a wrong id, someone else's file, an expired
 * one and a deleted blob are deliberately indistinguishable.
 */
async function downloadFile(req, res, next) {
    privateHeaders(res);
    const found = await loadForm(req, res);
    if (!found) return undefined;
    const loaded = await loadSession(found, req.params.sid);
    if (!loaded || loaded.expired) return res.status(404).json({ error: 'Not found' });

    const runIds = await journeyRunIds(loaded.session);
    if (runIds.length === 0) return res.status(404).json({ error: 'Not found' });
    const file = await automationStore.getGeneratedFileForRuns(req.params.fileId, runIds);
    if (!file) return res.status(404).json({ error: 'Not found' });

    let streamed;
    try {
        streamed = await storageStore.streamFile(file.storageKey);
    } catch (e) {
        // The reaper deletes blobs before rows, so a live row with no bytes
        // is a normal race rather than a server fault.
        log.warn(`[automation/form] generated file ${file.id} has no bytes: ${e.message}`);
        return res.status(404).json({ error: 'Not found' });
    }

    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    // nosniff + attachment: this is author-influenced content on a public
    // origin, so it must download rather than render in the page.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDisposition(file.filename));
    if (streamed.contentLength != null) res.setHeader('Content-Length', streamed.contentLength);
    streamed.stream.on('error', (e) => {
        log.error(`[automation/form] download stream failed: ${e.message}`);
        next(e);
    });
    return sendStream(streamed.stream, res);
}

/** GET /form/:token/s/:sid, GET /form/:token/s/:sid/file/:fileId — in that order. */
function register(router) {
    router.get('/form/:token/s/:sid', ipLimiter, sessionLimiter, friendly(pollSession, 'poll_failed', 'Could not check this form'));
    router.get('/form/:token/s/:sid/file/:fileId', ipLimiter, sessionLimiter, friendly(downloadFile, 'download_failed', 'Could not fetch this file'));
}

module.exports = { register };

// @typecheck
'use strict';
/**
 * The four run-read tool handlers (mcpRunReads.js). Each takes the access
 * object (makeAccess in mcpRunReadAccess.js) so a test hands in a store, then
 * the token user's id and the tool arguments. A refusal is an HttpError; the
 * dispatcher in mcpRunReads.js turns it into `{ error, code }`.
 */

const { HttpError } = require('../core/http/errors');
const {
    caps, capped, DEFAULT_LIST_LIMIT, ERROR_SUMMARY_CHARS, STEP_ERROR_CHARS, MAX_PATH_CHARS, MAX_ID_CHARS,
} = require('./mcpRunReadCaps');
const { describePayload, placeholderize } = require('./mcpRunReadShape');
const { errorLine, valueFreeErrorLine, fileNameShape, relativePathTokens } = require('./mcpRunReadScrub');
const { text } = require('./mcpRunReadAccess');
const { fallback } = require('../utils/bestEffort');

async function listRuns(acc, userId, args) {
    const { loadOwnedAutomation, requireRawAllowed, auditRawRead, store } = acc;
    const { automation, orgId } = await loadOwnedAutomation(text(args.automationId), userId);
    const { redactRunForViewer } = require('../core/automationModel/callerRunVisibility');
    const wantRaw = args.raw === true;
    if (wantRaw) await requireRawAllowed(orgId);
    const c = caps();
    const asked = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : DEFAULT_LIST_LIMIT;
    const status = text(args.status);
    const { runs, nextCursor } = await store().listRunsForAutomation(automation.id, {
        limit: capped(asked, c.list),
        viewerUserId: userId,
        ...(status ? { status: status.slice(0, 40) } : {}),
        ...(text(args.cursor) ? { cursor: text(args.cursor).slice(0, 400) } : {}),
    });
    if (wantRaw) await auditRawRead(orgId, userId, 'automation_runs', automation.id, { automationId: automation.id, what: 'error_text', runCount: (runs || []).length });
    return {
        automationId: automation.id,
        runs: (runs || []).map((raw) => {
            const r = redactRunForViewer(raw, userId);
            return {
                runId: r.id,
                journeyRunId: r.journeyRunId || null,
                status: r.status,
                startedAt: r.startedAt || null,
                finishedAt: r.finishedAt || null,
                durationMs: r.durationMs ?? null,
                version: r.version ?? null,
                triggerKind: r.triggerKind || null,
                mode: r.mode || null,
                isTest: !!r.isTest,
                errorClass: r.errorClass || null,
                errorSummary: wantRaw ? errorLine(r.error, ERROR_SUMMARY_CHARS) : valueFreeErrorLine(r.error, r.errorClass, ERROR_SUMMARY_CHARS),
                ...(r.dataHidden ? { dataHidden: true } : {}),
            };
        }),
        nextCursor: nextCursor || null,
    };
}

async function getRunSteps(acc, userId, args) {
    const { loadOwnedRun, requireRawAllowed, auditRawRead, store } = acc;
    const { run, legs, orgId } = await loadOwnedRun(args.runId, userId);
    const { redactChainStepsForViewer } = require('../core/automationModel/callerRunVisibility');
    const wantRaw = args.raw === true;
    if (wantRaw) await requireRawAllowed(orgId);
    const c = caps();
    const all = await store().getRunStepsForChain(run.id);
    const visible = redactChainStepsForViewer(run, legs, all, userId);
    const rows = c.steps > 0 ? visible.slice(0, c.steps) : visible;
    const limits = { keys: c.keys, nodes: c.nodes };
    if (wantRaw) await auditRawRead(orgId, userId, 'automation_run_steps', run.id, { runId: run.id, automationId: run.automationId, what: 'error_text', stepCount: rows.length });
    return {
        runId: run.id,
        automationId: run.automationId,
        status: run.status,
        stepCount: visible.length,
        ...(rows.length < visible.length ? { stepsOmitted: visible.length - rows.length } : {}),
        steps: rows.map((s) => {
            const durationMs = s.startedAt && s.finishedAt ? Math.max(0, Date.parse(s.finishedAt) - Date.parse(s.startedAt)) : null;
            return {
                stepId: s.stepId,
                parentStepId: s.parentStepId || null,
                runId: s.runId,
                type: s.stepType,
                attempts: s.attempts,
                status: s.status,
                startedAt: s.startedAt || null,
                finishedAt: s.finishedAt || null,
                durationMs,
                errorClass: s.errorClass || null,
                error: s.dataHidden ? null : (wantRaw ? errorLine(s.error, STEP_ERROR_CHARS) : valueFreeErrorLine(s.error, s.errorClass, STEP_ERROR_CHARS)),
                ...(s.dataHidden
                    ? { dataHidden: true }
                    : { input: describePayload(s.input, limits), output: describePayload(s.output, limits) }),
            };
        }),
    };
}

async function getStepOutput(acc, userId, args) {
    const { loadOwnedRun, findStep, requireRawAllowed, auditRawRead, store } = acc;
    const { run, orgId, automation, legs } = await loadOwnedRun(args.runId, userId);
    const { assertCanReadRunData } = require('../core/automationModel/callerRunVisibility');
    assertCanReadRunData(run, userId);
    const stepId = text(args.stepId);
    if (!stepId || stepId.length > MAX_ID_CHARS) throw new HttpError(400, 'invalid_step_id', 'stepId is required (from automations_get_run_steps).');
    const path = args.path == null ? '' : text(args.path);
    if (path.length > MAX_PATH_CHARS) throw new HttpError(400, 'invalid_path', `path is at most ${MAX_PATH_CHARS} characters.`);
    const attempts = Number.isInteger(args.attempts) && args.attempts > 0 ? args.attempts : 0;
    const wantRaw = args.raw === true;

    // Decided before any value is read: a refused raw read touches no payload.
    if (wantRaw) await requireRawAllowed(orgId);

    // A match segment ([key="value"]) answers "is there an element with this
    // value?" with a value or a 404: a yes/no probe on run data. Protected
    // reads refuse it; a raw read may use it, and its audit row keeps the
    // path without the value.
    let auditPath = path || null;
    if (path) {
        const tokens = relativePathTokens(path);
        if (tokens && tokens.some((t) => t.type === 'match')) {
            if (!wantRaw) throw new HttpError(400, 'invalid_path', 'Match segments such as [key="value"] are only available in a raw read. Use an index or [*] instead.');
            const { formatPath } = require('../shared/expr/index.mjs');
            auditPath = formatPath(tokens.map((t) => (t.type === 'match' ? { ...t, value: '«value»' } : t))).replace(/^\$\.?/, '');
        }
    }

    const row = await findStep(run, legs, stepId, attempts, userId);
    let output = row.output;
    const { fullOutputRefOf } = require('../core/automationModel/payloadTruncation');
    const ref = fullOutputRefOf(output);
    if (ref) {
        const full = await store().getRunFullOutput(ref.runId, ref.stepId, ref.attempts).catch((e) => fallback('automation/mcpRunReadHandlers:getStepOutput', e, null));
        if (full != null) output = full;
    }
    if (output === undefined || output === null) {
        return { runId: row.runId, stepId, attempts: row.attempts, mode: wantRaw ? 'raw' : 'protected', present: false };
    }

    let value = output;
    if (path) {
        const { getRelativePath } = require('../shared/expr/index.mjs');
        value = getRelativePath(output, path);
        if (value === undefined) throw new HttpError(404, 'path_not_found', `The output of "${stepId.slice(0, 80)}" has nothing at "${path.slice(0, 120)}". Read automations_get_run_steps for its shape.`);
    }

    const c = caps();
    let shown;
    if (wantRaw) {
        // Credentials the run log would mask stay masked in a raw read too.
        const { redactForPersistence } = require('../core/automationModel/runLogRedaction');
        shown = redactForPersistence(value).value;
    } else {
        shown = placeholderize(value);
    }

    let body = shown;
    let truncated = null;
    let bytes = 0;
    try { bytes = Buffer.byteLength(JSON.stringify(shown) ?? 'null', 'utf8'); } catch { bytes = 0; }
    if (c.bytes > 0 && bytes > c.bytes) {
        const { shapePreview } = require('../core/automationModel/payloadTruncation');
        const cut = shapePreview(shown, { maxBytes: c.bytes });
        body = cut ? cut.preview : null;
        truncated = { originalBytes: bytes, previewCut: cut ? cut.previewCut : undefined, note: 'Too large to return whole: read part of it with `path`.' };
    }

    if (wantRaw) {
        // The ledger row first, and no row means no data.
        await auditRawRead(orgId, userId, 'automation_run_step', `${row.runId}/${stepId}`, {
            runId: row.runId, stepId, attempts: row.attempts, automationId: automation.id, path: auditPath, bytes,
        });
    }

    return {
        runId: row.runId,
        stepId,
        attempts: row.attempts,
        path: path || null,
        mode: wantRaw ? 'raw' : 'protected',
        ...(wantRaw ? {} : { note: 'Strings are shown as «string:<length>» and numbers as «number». Structure and keys are real.' }),
        value: body,
        ...(truncated ? { truncated } : {}),
    };
}

async function listRunFiles(acc, userId, args) {
    const { loadOwnedRun, requireRawAllowed, auditRawRead, store } = acc;
    const { run, legs, orgId } = await loadOwnedRun(args.runId, userId);
    const { assertCanReadRunData, canReadRunData } = require('../core/automationModel/callerRunVisibility');
    assertCanReadRunData(run, userId);
    const wantRaw = args.raw === true;
    if (wantRaw) await requireRawAllowed(orgId);
    const c = caps();
    const ids = legs.filter((l) => canReadRunData(l, userId)).map((l) => l.id);
    const files = await store().listGeneratedFilesForRuns(ids);
    const rows = c.files > 0 ? files.slice(0, c.files) : files;
    if (wantRaw) await auditRawRead(orgId, userId, 'automation_run_files', run.id, { runId: run.id, automationId: run.automationId, what: 'file_names', fileCount: rows.length });
    // An explicit allow-list of fields: the storage key and anything added later stay out.
    return {
        runId: run.id,
        fileCount: files.length,
        ...(rows.length < files.length ? { filesOmitted: files.length - rows.length } : {}),
        files: rows.map((f) => ({
            fileId: f.id,
            name: wantRaw ? errorLine(f.filename, 200) : fileNameShape(f.filename),
            mime: f.mimeType || null,
            size: f.size ?? 0,
            stepId: f.stepId || null,
            runId: f.runId,
            createdAt: f.createdAt || null,
            expiresAt: f.expiresAt || null,
        })),
    };
}

module.exports = { listRuns, getRunSteps, getStepOutput, listRunFiles };

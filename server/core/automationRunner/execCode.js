// @typecheck
/**
 * The sandboxed code step and its two egress bridges (ctx.integrations and
 * ctx.http). The sandbox itself is automation/'s (isolated-vm), reached
 * through ./featurePorts.js; every call the code makes leaves through the
 * same guard and ledger as any other outbound step (./outboundGuard.js).
 */

'use strict';

const { resolveInputs } = require('../automationModel/bind');
const { shieldPart, joinShieldedUrl } = require('./httpQuery');
const { runnerPort } = require('./featurePorts');
const { prepareCodeRun } = require('./codeStepGuard');
const { isPrivateHost, guardOutbound } = require('./outboundGuard');
// Read as a module (not destructured) so a test that swaps
// shared.stepInputsSynthetic reaches this call.
const shared = require('./shared');
const safety = require('./safety');
// Each outbound call runs in its own capture context (core/http/captureCall.js).
const { captureCall: captured } = require('../http/captureCall');
const log = require('../../telemetry/log');
const { toolIdentity, permittedCatalog } = require('./toolIdentity');
const { fallback } = require('../../utils/bestEffort');

const sandbox = () => runnerPort('codeSandbox');

/**
 * A dry run that cannot run the code at all, said the way it used to be said.
 *
 * Reached only when the sandbox is missing or the platform/org gates are shut
 * — i.e. when a LIVE run of this step would refuse too. A rehearsal must not
 * be the thing that tells an author their org has code steps switched off, so
 * it reports a skip rather than raising the refusal a live run raises.
 */
function codeStepSkipped(why) {
    return { output: { _dryRun: true, skipped: `code-step skipped in dry-run: ${why}` } };
}

/**
 * Secrets — step.inputs.secretKeys[] is an authoring-time declaration that
 * NOTHING in this build can honour. `runState.secrets` is initialised to `{}`
 * in execution.js and no bridge, resume path or store ever assigns to it, so
 * the loop that used to stand here resolved every declared key to `null` and
 * handed that map to the sandbox. A step declaring `secretKeys: ['stripe_key']`
 * therefore ran with a credential of null and POSTed `Authorization: Bearer
 * null` to a third party, and the author got no signal at all — the run went
 * green. A declared-but-unfillable credential is a broken step, not a step
 * with an empty credential, so refuse it HERE, before any code runs and long
 * before an outbound call, rather than letting the failure happen at the far
 * end where the only evidence is a 401 from someone else's API.
 *
 * The sandbox raises the matching refusal for the other half of the lie —
 * code that calls ctx.secrets() without declaring anything (codeSandbox.js
 * header explains the whole shape). Nothing is passed as bridges.secrets any
 * more: the sandbox ignores it.
 */
function refuseDeclaredSecrets(step) {
    const declaredSecretKeys = Array.isArray(step.inputs?.secretKeys?.value) ? step.inputs.secretKeys.value
        : Array.isArray(step.inputs?.secretKeys) ? step.inputs.secretKeys
            : [];
    if (declaredSecretKeys.length > 0) {
        throw new Error(
            `This code step declares secretKeys (${declaredSecretKeys.join(', ')}), but `
            + sandbox().secretsNotConfiguredMessage());
    }
}

/**
 * Defense-in-depth permission check — mirrors execIntegrationAction's
 * re-resolve. step.allowedTools is design-time config; by the time a scheduled
 * automation actually fires, an org admin may have disabled the integration or
 * removed the user from the group that granted it. Re-resolve the user's
 * CURRENT allowed tool set (cached on ctx so this only runs once per run,
 * shared with any integration_action steps in the same graph) and intersect it
 * with the step's declared allowlist before handing anything to the sandbox.
 * Skipped entirely when the step declares no tools — nothing to validate.
 */
async function allowedCodeTools(step, ctx) {
    const declaredTools = new Set(step.allowedTools || []);
    if (declaredTools.size > 0 && !ctx.allowedToolNames) {
        try {
            const { getIntegrationTools } = require('../integrations/integrationTools');
            const r = await permittedCatalog(ctx, getIntegrationTools, { automationStep: true, lend: true });
            ctx.allowedToolNames = new Set((r.tools || []).map(t => t?.function?.name).filter(Boolean));
        } catch (e) {
            log.warn(`[AutomationRunner] Permission catalog lookup failed (code step): ${e.message}`);
            throw new Error('Could not verify your permission for this step\'s tools. The automation has been paused — please re-open it after refreshing your permissions.');
        }
    }
    return ctx.allowedToolNames
        ? new Set([...declaredTools].filter(name => ctx.allowedToolNames.has(name)))
        : declaredTools;
}

/**
 * ctx.integrations: a permitted tool, guarded, dispatched inside the bridge's
 * own capture context and logged. Both bridges used to bypass the shield
 * entirely: a code step could call any permitted tool, or fetch any URL, with
 * no scan and no ledger row.
 */
function makeExecuteToolBridge(step, ctx, mode, allowedTools) {
    const { executeTool } = require('../tools/toolDispatcher');
    return async (name, args) => {
        if (!allowedTools.has(name)) return { error: `tool "${name}" not allowed for this step` };
        const { resolveIntegration } = require('../integrations/integrationToolMap');
        const meta = resolveIntegration(name, args || {}, { nextcloudUrl: ctx.nextcloudUrl });
        let guardedCall;
        try {
            guardedCall = await guardOutbound(step, ctx, mode, {
                toolName: name,
                payload: args || {},
                destination: meta && meta.isLocal ? 'internal' : 'external',
                integMeta: meta,
            });
        } catch (err) {
            if (err && err.guardrailBlocked) return { error: err.message };
            throw err;
        }
        const t0 = Date.now();
        // Dispatched inside this bridge's own capture context, so the
        // dispatcher's chokepoint sees a probe and leaves the row to
        // the logEgress calls below (one row, with the peers).
        const who = toolIdentity(ctx);
        const call = await captured(() => executeTool(name, guardedCall.payload, {
            userId: who.userId, session: who.session, orgId: who.orgId,
            userGroupIds: who.userGroupIds,
            connectionsCallerUserId: ctx.callerOnly ? ctx.callerOnly.userId : null,
            userOrgIds: ctx.userOrgIds || [],
            runScope: ctx.runId ? { runId: ctx.runId, rootRunId: ctx.rootRunId || ctx.runId } : null,
            egress: false,
        }));
        const logged = { toolName: name, toolArgs: guardedCall.payload, probe: call.probe, policy: guardedCall.policy, auditBase: guardedCall.auditBase, mode };
        try {
            if (!call.ok) throw call.error;
            const value = call.value;
            await safety.logEgress({ ...logged, result: value, durationMs: Date.now() - t0 });
            const gOut = await safety.guardToolOutput(value, guardedCall.policy, guardedCall.auditBase, mode, ctx);
            return safety.restoreForRunState(gOut.result, ctx);
        } catch (err) {
            await safety.logEgress({ ...logged, error: err, durationMs: Date.now() - t0 });
            throw err;
        }
    };
}

/** ctx.http: a host on the step's list, guarded (request headers included), sent, logged, and its reply guarded. */
function makeFetchHttpBridge(step, ctx, mode, guard) {
    return async (url, options) => {
        let host = '';
        try { host = new URL(String(url)).hostname; } catch (err) { fallback('core/automationRunner/execCode:makeFetchHttpBridge', err); /* let the sandbox reject it */ }
        const offList = host ? guard.refuseHost(host) : null;
        if (offList) return { error: offList };
        const meta = {
            integration: 'http_request', label: host || 'http',
            server: host ? `https://${host}` : null, direction: 'both',
            dataCategories: 'auto_detected', isLocal: isPrivateHost(host),
        };
        // REQUEST HEADERS are part of the egress. Only {url, body} used
        // to be guarded here while `options` was forwarded to safeFetch
        // verbatim, so anything the sandboxed code put in a header left
        // the platform unscanned, unmasked and unaudited — the exact
        // hole execHttpRequest closes with its guardableHeaders block.
        // `options` arrives JSON-parsed from the isolate, so headers is
        // a plain object; anything else is left alone rather than being
        // silently flattened into one.
        const rawHeaders = options && options.headers;
        const guardableHeaders = (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders))
            ? rawHeaders : undefined;
        const guardedFetch = await guardOutbound(step, ctx, mode, {
            toolName: 'code_fetch_http',
            payload: { url: shieldPart(String(url)), body: options && options.body, headers: guardableHeaders },
            destination: isPrivateHost(host) ? 'internal' : 'external',
            integMeta: meta,
        });
        const sendUrl = joinShieldedUrl(String(url), guardedFetch.payload.url);
        const t0 = Date.now();
        // What travels is built FROM THE GUARDED RESULT, never from the
        // caller's object — that is the whole point of the guard.
        const sendOptions = { ...(options || {}) };
        if (guardedFetch.payload.body !== undefined) sendOptions.body = guardedFetch.payload.body;
        if (guardableHeaders) sendOptions.headers = guardedFetch.payload.headers || {};
        const call = await captured(() => sandbox().defaultFetchHttp(sendUrl, sendOptions));
        const logged = { toolName: 'code_fetch_http', toolArgs: { url: sendUrl }, probe: call.probe, policy: guardedFetch.policy, auditBase: guardedFetch.auditBase, mode, integMeta: meta };
        let res;
        try {
            if (!call.ok) throw call.error;
            res = call.value;
            await safety.logEgress({ ...logged, result: { ok: true }, durationMs: Date.now() - t0 });
        } catch (err) {
            await safety.logEgress({ ...logged, error: err, durationMs: Date.now() - t0 });
            throw err;
        }
        // The RESPONSE is step output: the sandbox hands it to user code
        // and its return value is written into runState. execHttpRequest
        // has always guarded its reply (egressCoverage pins that
        // contract); this bridge did not, so the same third-party body
        // that a `block` policy stops on an http_request step landed
        // freely in runState via a code step.
        let guardedRes;
        try {
            guardedRes = await safety.guardToolOutput(res, guardedFetch.policy, guardedFetch.auditBase, mode, ctx);
        } catch (err) {
            // The sandbox already speaks `{ error }` — the same shape a
            // refused URL or a blocked tool call comes back as.
            if (err && err.guardrailBlocked) return { error: err.message };
            throw err;
        }
        return safety.restoreForRunState(guardedRes.result, ctx);
    };
}

async function execCode(step, ctx, runState, mode) {
    const rehearsal = mode === 'dry_run';
    // A DRY RUN USED TO SKIP THE CODE OUTRIGHT. Of every step type, this is
    // the one where skipping teaches nothing: the whole question about a code
    // step is whether the code works, and "code-step skipped in dry-run" is
    // the answer to a question nobody asked. Meanwhile the first time the
    // author found out about their typo was a live run — which is exactly the
    // run a rehearsal exists to save them from.
    //
    // It is also the step type with the broadest reach: ctx.integrations can
    // send mail, ctx.http can POST to any public host, ctx.db writes. So the
    // code RUNS and the outside is stubbed (codeSandbox testBridges): every
    // call is recorded and answered with an obviously-fake value, so the line
    // after it still executes and the author finds out their code throws on
    // line 12 instead of finding out that it "was skipped".
    if (!sandbox().isAvailable()) {
        if (rehearsal) return codeStepSkipped('the sandbox is not installed here');
        throw new Error(`Code step unavailable: ${sandbox().loadError()}`);
    }

    // There is no switch: code steps run wherever the sandbox is installed.
    // The platform flag and the per-org `ai_code_execution` beta that used to
    // sit here are gone; the sandbox is the safety boundary.

    // The code's own rules: BLOCK findings stop it, declared parameters get
    // their defaults and types, ctx.http keeps to the host list (codeStepGuard.js).
    const guard = prepareCodeRun(step, resolveInputs(step.inputs || {}, runState, { allowSecrets: false, listAs: 'json' }));
    if (guard.refusal) {
        if (rehearsal) return codeStepSkipped(guard.refusal);
        throw new Error(guard.refusal);
    }
    const inputs = guard.inputs;
    // Whether anything this code is about to read was invented upstream. Asked
    // BEFORE the run, because the answer is about the data going in, and used
    // only to label the rehearsal's output — see the note where it is attached.
    const syntheticInputs = rehearsal && shared.stepInputsSynthetic(step, runState, ctx);
    refuseDeclaredSecrets(step);
    const allowedTools = await allowedCodeTools(step, ctx);

    const { result, logs, http, calls } = await sandbox().runCode({
        code: step.code,
        inputs,
        limits: step.limits || {},
        // Fairness unit for the sandbox's concurrency cap (codeSandboxSlots.js).
        concurrencyKey: ctx.orgId || ctx.userId || null,
        // The bridges below are still BUILT in a rehearsal and simply never
        // reached: the sandbox swaps them for recording stubs. Building them
        // anyway keeps the permission re-resolve above on the rehearsal path
        // too, so a dry run still refuses a tool the author has since lost
        // access to — a rehearsal that permits more than the real run would
        // teach exactly the wrong lesson.
        mode: rehearsal ? 'test' : 'live',
        bridges: {
            executeTool: makeExecuteToolBridge(step, ctx, mode, allowedTools),
            allowedTools,
            fetchHttp: makeFetchHttpBridge(step, ctx, mode, guard),
        },
    });
    // The sandbox's return value + logs go straight into runState and from
    // there into every downstream node — they used to do so with no output
    // guard at all, which made the code step a way around the toolOutput scope
    // that execIntegrationAction and execHttpRequest both enforce. Guard, then
    // restore from the run vault so downstream steps still see real values.
    const codePolicy = await safety.resolveAutomationPolicy(ctx);
    const codeAudit = safety.buildAuditBase(ctx, step);
    const guardedCode = await safety.guardToolOutput({ result, logs }, codePolicy, codeAudit, mode, ctx);
    const restoredCode = safety.restoreForRunState(guardedCode.result, ctx) || {};
    return {
        output: {
            result: restoredCode.result,
            logs: restoredCode.logs,
            httpCalls: http.calls,
            // A rehearsal SAYS what it would have done rather than letting a
            // stubbed answer pass for a real one. Without this the run reads
            // as a step that called nothing, which is the same false
            // reassurance the old skip gave, one layer further in.
            //
            // And when the inputs were SYNTHESIZED upstream (a sample
            // fallback, a simulated side effect, a synthetic trigger) it says
            // that too. The code still runs — a syntax error, a null deref or
            // a wrong branch is worth finding whatever the data was — but a
            // throw on a shape the real data would never have had is a false
            // alarm, and a false alarm that reads like a real one is how
            // people learn to ignore the rehearsal. execAi refuses to dispatch
            // at all in this case (dryRunFallback: 'synthetic_input'); here
            // running locally costs nothing and teaches more, so it runs and
            // is labelled instead.
            ...(rehearsal ? {
                _dryRun: true,
                wouldHaveCalled: calls || [],
                ...(syntheticInputs ? { _dryRunSyntheticInputs: true } : {}),
            } : {}),
        },
    };
}

module.exports = { execCode };

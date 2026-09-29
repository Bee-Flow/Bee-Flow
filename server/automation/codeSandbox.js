/**
 * Sandboxed JavaScript execution for automation `code` steps.
 *
 * Uses `isolated-vm` (V8 isolate) — separate heap, no Node bindings, no
 * filesystem, no raw network. Host bridges expose:
 *   - inputs            : the resolved step inputs
 *   - ctx.log(...)      : captured per-run, surfaced in run-step output
 *   - ctx.http(url, opts): HTTPS-only fetch proxy with hard limits
 *   - ctx.integrations.<tool>(args) : proxy to toolDispatcher.executeTool
 *   - ctx.secrets(name) : NOT WIRED — always throws SecretsNotConfiguredError.
 *
 * About ctx.secrets. This header used to promise "returns only secrets
 * explicitly listed in step.inputs.secretKeys", and builderTools/schemas.js
 * advertised the same thing to the model that writes code steps. It was never
 * true: the only source the runner ever read from is `runState.secrets`, which
 * execution.js initialises to `{}` and which NOTHING in the codebase ever
 * assigns to (grep it). So `bridges.secrets` arrived empty from both call
 * sites, `ctx.secrets('stripe_key')` returned null, and a handler built on
 * that promise silently sent `null` to a third party with no run-level signal
 * that anything was wrong. A credential that reads as empty is far worse than
 * one that is absent — the author has no way to find out. So the bridge now
 * fails loudly instead: ctx.secrets(name) throws an in-isolate Error whose
 * .name is 'SecretsNotConfiguredError' and whose .secretName is the key that
 * was asked for, so user code can catch it by name and a step that does not
 * catch it stops with a legible message in the run log.
 *
 * `bridges.secrets` is still ACCEPTED and IGNORED, so the one caller that
 * still passes it — integrations/webpageApiRuntime, which hands over an empty
 * object — keeps working unchanged; execCode stopped passing it at all.
 * Ignoring rather than rejecting it is deliberate: a caller whose object is
 * empty anyway gets the same observable result, and the refusal that matters
 * is the one user code sees. Wiring real secrets is a
 * deliberate follow-up: it needs a store, a migration and a permission
 * decision about who may bind which key to which step. When that lands, this
 * is the seam — re-introduce the host bridge here and delete the throw.
 *
 * Limits per call:
 *   memoryMb : default 64
 *   cpuMs    : default 1000  (V8 timeout)
 *   wallMs   : default 5000  (host-side Promise.race)
 *
 * There is no switch: code steps run wherever this sandbox is installed. If
 * isolated-vm is not installed, the runner refuses to execute code steps with
 * a clear error rather than crashing on require().
 */

const { isPrivateHostname, safeFetch, isPrivateAddressError } = require('../utils/ssrfGuard');
const { HTTP_RESPONSE_CAP } = require('./httpResponseLimits');
const { acquireSlot } = require('./codeSandboxSlots');
const log = require('../telemetry/log');

let ivm = null;
let ivmLoadError = null;
try {
    ivm = require('isolated-vm');
} catch (e) {
    ivmLoadError = e;
    // The runner reads `isAvailable()` before calling runCode().
}

function isAvailable() { return ivm != null; }
function loadError() { return ivmLoadError ? ivmLoadError.message : null; }

const DEFAULT_LIMITS = { memoryMb: 64, cpuMs: 1000, wallMs: 5000 };
// Hard ceilings for the author-controlled per-step limits. Code steps run
// IN-PROCESS (isolated-vm shares the host's heap budget and event loop), so
// an oversized memoryMb/cpuMs/wallMs from a crafted step definition is a
// shared-host resource-exhaustion vector — every other tenant's runs on that
// pod slow down or OOM. Clamp before the isolate is ever constructed.
const MAX_LIMITS = { memoryMb: 256, cpuMs: 10_000, wallMs: 30_000, httpBudget: 20 };
const HTTP_BUDGET_DEFAULT = 5;

// Host-side size caps. Everything the isolate hands out is COPIED into the
// API process's heap before any guard sees it, so a step that logs in a loop,
// returns a huge object or posts a huge body grows the host, not the isolate.
const LOG_LINE_CAP = 4 * 1024;          // one ctx.log line
const LOG_TOTAL_CAP = 64 * 1024;        // all ctx.log output of one run
const RESULT_CAP = 1024 * 1024;         // the value main() returns, as JSON
const OUTBOUND_REQUEST_CAP = 256 * 1024; // one ctx.http options object (body + headers), as JSON
const OUTBOUND_TOTAL_CAP = 1024 * 1024; // everything sent out by one run (http + tool arguments)
// How often the CPU watchdog reads isolate.cpuTime. isolated-vm's `timeout`
// only covers the run up to the first yield, so after an `await` only this
// watchdog (and the wall clock) bounds the CPU a step can burn.
const CPU_WATCH_INTERVAL_MS = 25;

// The single wording for "ctx.secrets does not exist here". Exported so
// execOutbound's own refusal (a step that DECLARES secretKeys) reads the same
// as the sandbox's, and so tests pin one string instead of two copies that
// drift apart. See the header for why this is a throw and not a null.
const SECRETS_NOT_CONFIGURED_NAME = 'SecretsNotConfiguredError';
const SECRETS_NOT_CONFIGURED_MESSAGE =
    'ctx.secrets is not wired in this build: no secret store is connected to code steps, '
    + 'so it can never return a value. Pass the value in through the step inputs, or use an '
    + 'integration tool that carries its own credentials.';
// HTTP_RESPONSE_CAP now lives in ./httpResponseLimits, shared with
// execOutbound.js's declarative http_request step — see that module for why
// the two surfaces react differently to hitting it.

// Coerce one numeric limit to a finite value within [min, max], falling back
// to `def` when the supplied value is missing or not a finite number.
function clampLimit(value, def, min, max) {
    if (value == null) return def; // missing/null → default (Number(null) is 0, not NaN)
    const n = Number(value);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(n, max));
}

function clampLimits(limits = {}) {
    return {
        memoryMb: clampLimit(limits.memoryMb, DEFAULT_LIMITS.memoryMb, 8, MAX_LIMITS.memoryMb),
        cpuMs: clampLimit(limits.cpuMs, DEFAULT_LIMITS.cpuMs, 50, MAX_LIMITS.cpuMs),
        wallMs: clampLimit(limits.wallMs, DEFAULT_LIMITS.wallMs, 100, MAX_LIMITS.wallMs),
        httpBudget: clampLimit(limits.httpBudget, HTTP_BUDGET_DEFAULT, 0, MAX_LIMITS.httpBudget),
    };
}

/**
 * An error from inside the isolate, said in the author's own coordinates.
 *
 * V8 counts lines from the top of the script it compiled, and what it
 * compiles is our ctx bootstrap with the author's code spliced into the
 * middle — so "line 34" meant the author's line 1, and every number in a
 * stack was wrong by the same amount, in a box whose only debugging tool IS
 * the error message. `compileScript` takes a negative `lineOffset`, which
 * fixes the numbers AT THE SOURCE for both the syntax error and the runtime
 * stack; nothing is re-shifted here, because shifting an already-correct
 * number is how a fix like this turns into a second, opposite bug.
 *
 * What is left is only the SPELLING. isolated-vm reports a compile failure as
 * `Unexpected token ';' [step.js:4:11]`, and "step.js" is a filename we
 * invented for a file the author has never seen — their code lives in a step,
 * not a file. So the bracketed coordinate becomes the sentence a person
 * reads: "line 4, column 11".
 */
function describeCodeError(e) {
    const msg = (e && e.message) || String(e);
    return msg
        .replace(/\[step\.js:(\d+):(\d+)\]/g, 'at line $1, column $2')
        .replace(/\[step\.js:(\d+)\]/g, 'at line $1')
        .replace(/\bstep\.js:(\d+):(\d+)/g, 'line $1, column $2')
        .replace(/\bstep\.js:(\d+)/g, 'line $1');
}

/**
 * The bridges a TEST run gets: the same surface, none of the consequences.
 *
 * A dry run has always SKIPPED code steps outright ("code-step skipped in
 * dry-run"), which is the one step type where skipping teaches nothing — the
 * whole question about a code step is whether the code works. But a code step
 * is also the step type with the broadest reach: `ctx.integrations.<tool>`
 * can send mail, `ctx.http` can POST anywhere public, `ctx.db` writes. Running
 * it for real during a rehearsal would mail the customer.
 *
 * So the code runs and the OUTSIDE is stubbed. Every call is recorded and
 * answered with a shaped placeholder, so `const r = await ctx.http(...)`
 * still gets an object with a status and a body and the line after it still
 * executes — which is the point: the author finds out their code throws on
 * line 12, not that the step "was skipped".
 *
 * The placeholders are deliberately OBVIOUS rather than plausible. A stubbed
 * body of `{}` or `""` reads like a real empty answer and sends someone
 * hunting for a bug in the far end; `_stub: true` beside the tool's own name
 * cannot be mistaken for data that came back from anywhere.
 */
function testBridges(bridges = {}) {
    const calls = [];
    return {
        calls,
        bridges: {
            ...bridges,
            executeTool: async (name, args) => {
                calls.push({ kind: 'tool', name, args });
                return { _stub: true, tool: name, note: 'Not sent — this was a test run.' };
            },
            fetchHttp: async (url, opts) => {
                calls.push({ kind: 'http', name: url, args: opts || {} });
                return {
                    _stub: true, status: 200, headers: {},
                    body: '', note: 'Not sent — this was a test run.',
                };
            },
            // A db bridge is only ever present for a webpage handler, and a
            // read is as stubbed as a write here: answering a query with real
            // rows would put customer data in a rehearsal's output.
            ...(typeof bridges.db === 'function' ? {
                db: async (op, args) => {
                    calls.push({ kind: 'db', name: op, args });
                    return { _stub: true, rows: [], changes: 0, note: 'Not run — this was a test run.' };
                },
            } : {}),
        },
    };
}

/**
 * Run user-provided JS in the sandbox.
 *
 * @param {object} options
 * @param {string} options.code        Source. May be a single expression,
 *                                     a top-level await block, or a function
 *                                     definition `function main(inputs, ctx)`.
 * @param {object} options.inputs      Resolved inputs (already free of secrets unless declared).
 * @param {object} options.limits      Optional resource limits.
 * @param {object} options.bridges
 *   bridges.executeTool(toolName, args)  → resolves a tool call (host-side toolDispatcher).
 *   bridges.allowedTools                 Set<string> of tool names the step may call.
 *   bridges.fetchHttp(url, opts)         HTTPS fetch helper (host-side).
 *   bridges.secrets                      ACCEPTED AND IGNORED — no secret store is
 *                                        wired; ctx.secrets() throws. See the header.
 * @param {string} options.mode       'live' (default) runs for real. 'test' runs the
 *                                    author's code with every outward bridge stubbed
 *                                    and records what it would have called — see
 *                                    testBridges for why a rehearsal must not mail
 *                                    the customer and must not merely skip either.
 *
 * @param {string|null} options.concurrencyKey  The fairness unit for the
 *                                    concurrency cap (codeSandboxSlots.js): the org.
 *
 * @returns {Promise<{ result, logs, http: { calls }, calls? }>}
 *          `calls` is present only for a test run.
 */
async function runCode({ code, inputs = {}, limits = {}, bridges = {}, mode = 'live', concurrencyKey = null } = {}) {
    if (!isAvailable()) {
        const msg = loadError() || 'isolated-vm not installed';
        throw new Error(`Code step disabled: ${msg}`);
    }
    // Never trust the caller's limits verbatim — clamp to hard ceilings so a
    // step definition can't request e.g. 8 GB / 10 min and starve the host.
    const lim = clampLimits(limits);
    const logs = [];
    let logBytes = 0;
    let logsTruncated = false;
    let outboundBytes = 0;
    let httpCalls = 0;
    const httpBudget = lim.httpBudget;

    // A test run executes the author's code and stubs everything that would
    // leave the box — see testBridges. `calls` is what it would have done,
    // and it is returned so a rehearsal can SHOW that instead of claiming it
    // happened.
    let testCalls = null;
    if (mode === 'test') {
        const stubbed = testBridges(bridges);
        testCalls = stubbed.calls;
        bridges = stubbed.bridges;
    }

    // One of a bounded number of isolates at a time, per process and per org.
    const releaseSlot = await acquireSlot({ key: concurrencyKey });
    let isolate;
    try {
        isolate = new ivm.Isolate({
            memoryLimit: lim.memoryMb,
            // V8 has lost control of the isolate: its memory is unrecoverable
            // and the process can no longer be trusted. isolated-vm's own advice
            // is to log, stop and abort; the orchestrator restarts the pod.
            onCatastrophicError: (message) => {
                log.error(`[codeSandbox] catastrophic isolate error, aborting the process: ${message}`);
                process.abort();
            },
        });
    } catch (e) {
        releaseSlot();
        throw e;
    }
    // EVERYTHING from here on is inside the guard. See the note above the
    // compile below for what leaked before it was: in short, a syntax error
    // in the author's own code — and a value in `inputs` that ExternalCopy
    // cannot clone — threw past the disposal and left a whole V8 isolate,
    // up to `memoryMb` of heap, alive for the life of the process.
    let context = null;
    let script = null;
    let bootScript = null;
    let timedOut = false;
    let cpuExceeded = false;
    let wallTimer = null;
    let cpuWatch = null;
    try {
        context = await isolate.createContext();
        const jail = context.global;

        await jail.set('global', jail.derefInto());
        await jail.set('inputs', new ivm.ExternalCopy(inputs).copyInto({ release: true }));

        // Host bridge: ctx (Reference into a host object)
        const allowed = bridges.allowedTools instanceof Set ? bridges.allowedTools : null;

        const ctxHost = {
            log: (...args) => {
                if (logsTruncated) return;
                let line;
                try { line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '); } catch { return; }
                if (line.length > LOG_LINE_CAP) line = `${line.slice(0, LOG_LINE_CAP)}… (line cut at ${LOG_LINE_CAP} characters)`;
                if (logBytes + line.length > LOG_TOTAL_CAP) {
                    logsTruncated = true;
                    logs.push(`… more log output was dropped (limit ${LOG_TOTAL_CAP / 1024} KB per run)`);
                    return;
                }
                logBytes += line.length;
                logs.push(line);
            },
            // Returns a JSON-serialisable result.
            callTool: async (toolName, argsJson) => {
                if (typeof bridges.executeTool !== 'function') return { error: 'no executeTool bridge' };
                if (allowed && !allowed.has(toolName)) return { error: `tool "${toolName}" not allowed for this step` };
                const sent = typeof argsJson === 'string' ? argsJson.length : 0;
                if (outboundBytes + sent > OUTBOUND_TOTAL_CAP) return { error: `this run already sent ${OUTBOUND_TOTAL_CAP / 1024} KB, the most one run may send` };
                outboundBytes += sent;
                let argsObj = {};
                try { argsObj = argsJson ? JSON.parse(argsJson) : {}; } catch { return { error: 'invalid tool args' }; }
                try {
                    const r = await bridges.executeTool(toolName, argsObj);
                    return r;
                } catch (e) {
                    return { error: e.message || String(e) };
                }
            },
            http: async (url, optsJson) => {
                if (typeof bridges.fetchHttp !== 'function') return { error: 'no http bridge' };
                if (httpCalls >= httpBudget) return { error: `http call budget exceeded (${httpBudget})` };
                const sent = typeof optsJson === 'string' ? optsJson.length : 0;
                if (sent > OUTBOUND_REQUEST_CAP) return { error: `request too large: ${Math.ceil(sent / 1024)} KB, the limit is ${OUTBOUND_REQUEST_CAP / 1024} KB per request` };
                if (outboundBytes + sent > OUTBOUND_TOTAL_CAP) return { error: `this run already sent ${OUTBOUND_TOTAL_CAP / 1024} KB, the most one run may send` };
                outboundBytes += sent;
                httpCalls++;
                let opts = {};
                try { opts = optsJson ? JSON.parse(optsJson) : {}; } catch { return { error: 'invalid http opts' }; }
                try {
                    const r = await bridges.fetchHttp(url, opts, { responseCap: HTTP_RESPONSE_CAP, timeoutMs: 10_000 });
                    return r;
                } catch (e) {
                    return { error: e.message || String(e) };
                }
            },
            // NOTE: there is deliberately no `secret` host bridge any more. The
            // refusal is raised INSIDE the isolate (see the bootstrap below) so
            // the Error that user code catches is a real in-isolate Error with a
            // stable .name — a host-thrown error crossing the isolated-vm boundary
            // is re-created there and does not keep a custom constructor name, so
            // `catch (e) { e.name === 'SecretsNotConfiguredError' }` would not hold.

            // Optional host-provided database bridge (used by webpage api/* handlers
            // to reach the per-page SQLite). op ∈ 'query'|'exec'|'batch'.
            db: async (op, argsJson) => {
                if (typeof bridges.db !== 'function') return { error: 'no db bridge' };
                let a = {};
                try { a = argsJson ? JSON.parse(argsJson) : {}; } catch { return { error: 'invalid db args' }; }
                try { return await bridges.db(op, a); } catch (e) { return { error: e.message || String(e) }; }
            },
        };

        // The guest never holds an isolated-vm object. Holding a single
        // `ivm.Reference` is the precondition of GHSA-864f-rcv7-6rh4
        // (critical, 2026-08-07: a guest with one Reference can reach the
        // ExternalCopy constructor and corrupt host memory), and this file
        // used to put four of them on the global. Now every host function is
        // a fire-and-forget CALLBACK (inside the isolate: a plain function,
        // arguments copied) that takes a call id; the host does the work and
        // delivers the answer by calling an in-isolate settle function that
        // only the HOST holds a reference to. The bootstrap script below
        // captures the callbacks, builds a frozen `ctx`, and deletes every
        // internal global before the author's code is even compiled.
        let settleRef = null;
        const settle = (id, value) => {
            if (!settleRef) return;
            settleRef.apply(undefined, [id, value], { arguments: { copy: true } }).catch(() => {
                // The isolate was disposed (timeout, CPU, finished): nobody is waiting.
            });
        };
        const answer = (id, work) => {
            Promise.resolve().then(work).then(
                (value) => settle(id, value === undefined ? null : value),
                (e) => settle(id, { error: (e && e.message) || String(e) }),
            );
        };
        await jail.set('__hostCallTool', new ivm.Callback((id, toolName, argsJson) => answer(id, () => ctxHost.callTool(toolName, argsJson)), { ignored: true }));
        await jail.set('__hostHttp', new ivm.Callback((id, url, optsJson) => answer(id, () => ctxHost.http(url, optsJson)), { ignored: true }));
        await jail.set('__hostLog', new ivm.Callback(ctxHost.log, { ignored: true }));
        const hasDb = typeof bridges.db === 'function';
        if (hasDb) await jail.set('__hostDb', new ivm.Callback((id, op, argsJson) => answer(id, () => ctxHost.db(op, argsJson)), { ignored: true }));

        bootScript = await isolate.compileScript(`(() => {
            const h = {
                tool: globalThis.__hostCallTool, http: globalThis.__hostHttp, log: globalThis.__hostLog,
                db: typeof globalThis.__hostDb === 'function' ? globalThis.__hostDb : null,
            };
            delete globalThis.__hostCallTool; delete globalThis.__hostHttp; delete globalThis.__hostLog; delete globalThis.__hostDb;
            const pending = new Map();
            let seq = 0;
            const call = (fn, args) => new Promise((resolve) => {
                seq += 1;
                pending.set(seq, resolve);
                fn(seq, ...args);
            });
            globalThis.__bfSettle = (id, value) => {
                const resolve = pending.get(id);
                if (resolve) { pending.delete(id); resolve(value); }
            };
            globalThis.__bfCtx = Object.freeze({${hasDb ? `
                db: Object.freeze({
                    query: (sql, params) => call(h.db, ['query', JSON.stringify({ sql: sql, params: params || [] })]),
                    exec: (sql, params) => call(h.db, ['exec', JSON.stringify({ sql: sql, params: params || [] })]),
                    batch: (statements) => call(h.db, ['batch', JSON.stringify({ statements: statements || [] })]),
                }),` : ''}
                log: (...args) => { h.log(...args.map(a => typeof a === 'string' ? a : JSON.stringify(a))); },
                // Loud, catchable, and never a value. Built here rather than on
                // the host so .name survives: see the ctxHost note above.
                secrets: (name) => {
                    const err = new Error('ctx.secrets(' + JSON.stringify(name) + '): ' + ${JSON.stringify(SECRETS_NOT_CONFIGURED_MESSAGE)});
                    err.name = ${JSON.stringify(SECRETS_NOT_CONFIGURED_NAME)};
                    err.secretName = typeof name === 'string' ? name : null;
                    throw err;
                },
                integrations: new Proxy({}, {
                    get(_, toolName) {
                        if (typeof toolName !== 'string') return undefined;
                        return async (args) => call(h.tool, [toolName, args === undefined ? '{}' : JSON.stringify(args)]);
                    },
                }),
                http: async (url, opts) => call(h.http, [url, opts === undefined ? '{}' : JSON.stringify(opts)]),
            });
        })();`, { filename: 'bootstrap.js' });
        await bootScript.run(context, { timeout: 1000 });
        settleRef = await jail.get('__bfSettle', { reference: true });
        await jail.delete('__bfSettle');

        // The author's code, wrapped in an async IIFE.
        //
        // Built as PREFIX + code + SUFFIX rather than one template literal, so the
        // number of lines standing in front of the author's first line is a
        // computed fact rather than something a later edit to this string can
        // silently change. V8 counts from the top of the script it compiled, so
        // without that offset every error the author sees points at a line of
        // ours: "line 34" for the first line they wrote. That is not a cosmetic
        // problem in a box where the only debugging tool is the error message.
        const prefix = `
        const ctx = globalThis.__bfCtx;
        delete globalThis.__bfCtx;
        (async () => {
`;
        const suffix = `
            if (typeof main === 'function') return await main(inputs, ctx);
            return undefined;
        })().then((out) => {
            // Measured HERE, before the value is copied into the host heap.
            let size = 0;
            try { size = (JSON.stringify(out) || '').length; } catch (_) { size = 0; }
            if (size > ${RESULT_CAP}) {
                throw new Error('The step returned ' + Math.ceil(size / 1024) + ' KB; the most a code step may return is ${RESULT_CAP / 1024} KB. Return only the fields the next steps use.');
            }
            return out;
        })
    `;
        const bootstrap = prefix + code + suffix;
        // The author's line 1 is this many lines down the compiled script, so
        // V8 is told to count from there instead — which fixes the syntax
        // error's number and every frame of a runtime stack at once.
        const lineOffset = prefix.split('\n').length - 1;

        // A SYNTAX ERROR IN THE AUTHOR'S CODE THROWS HERE, and `compileScript`
        // used to sit OUTSIDE the try/finally below. So every typo leaked a
        // whole V8 isolate — up to `memoryMb` of heap, 64 MB by default — for
        // the lifetime of the process, and a typo is the single most common
        // thing to happen to code being written. Nothing about it was visible:
        // the author got their syntax error, the run failed cleanly, and the
        // pod's memory climbed. It was survivable only because there was no
        // way to run a code step from the editor; the moment there is a Run
        // button, an author iterating on a function leaks one per run.
        //
        // The same was true of everything above it — createContext, each
        // jail.set, and the ExternalCopy of `inputs`, which throws on a value
        // it cannot clone, i.e. on data the author supplied. All of it is
        // inside the guard now.
        script = await isolate.compileScript(bootstrap, { filename: 'step.js', lineOffset: -lineOffset });
        wallTimer = setTimeout(() => { timedOut = true; isolate.dispose(); }, lim.wallMs);
        const cpuBudgetNs = BigInt(Math.round(lim.cpuMs * 1e6));
        cpuWatch = setInterval(() => {
            try {
                if (!isolate.isDisposed && isolate.cpuTime > cpuBudgetNs) { cpuExceeded = true; isolate.dispose(); }
            } catch (_) { /* disposed between the check and the read */ }
        }, CPU_WATCH_INTERVAL_MS);
        const result = await script.run(context, { timeout: lim.cpuMs, promise: true, copy: true });
        return { result, logs, http: { calls: httpCalls }, ...(testCalls ? { calls: testCalls } : {}) };
    } catch (e) {
        // isolated-vm's own `timeout` ("Script execution timed out.") and the
        // watchdog race for the same budget; either way the CPU limit is what
        // stopped the code, and the author reads one sentence for it.
        if (cpuExceeded || (!timedOut && /Script execution timed out/i.test((e && e.message) || ''))) {
            throw new Error(`Code step exceeded CPU limit (${lim.cpuMs}ms)`);
        }
        if (timedOut) throw new Error(`Code step exceeded wall-clock limit (${lim.wallMs}ms)`);
        throw new Error(`Code step error: ${describeCodeError(e)}`);
    } finally {
        if (wallTimer) clearTimeout(wallTimer);
        if (cpuWatch) clearInterval(cpuWatch);
        releaseSlot();
        try { if (script) script.release(); } catch {}
        try { if (bootScript) bootScript.release(); } catch {}
        try { if (context) context.release(); } catch {}
        try { if (!isolate.isDisposed) isolate.dispose(); } catch {}
    }
}

/**
 * HTTPS-only fetch helper used by ctx.http inside the sandbox. The
 * runner injects this so we keep network policy in one place.
 *
 * SSRF guard: private/internal hostnames fast-fail before any network
 * activity, and safeFetch revalidates DNS at every socket connect — so a
 * public hostname that resolves (or rebinds, or redirects) to a private
 * address is refused too. All refusals surface as the same structured
 * { error } shape user code already gets.
 */
async function defaultFetchHttp(url, opts = {}, { responseCap = HTTP_RESPONSE_CAP, timeoutMs = 10_000 } = {}) {
    if (typeof url !== 'string' || !url.startsWith('https://')) {
        return { error: 'Only https:// URLs are allowed.' };
    }
    let hostname;
    try { hostname = new URL(url).hostname; } catch (e) { return { error: e.message || String(e) }; }
    if (isPrivateHostname(hostname)) {
        return { error: 'Refused: target resolves to a private/internal address.' };
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const resp = await safeFetch(url, {
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body !== undefined ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
            signal: ac.signal,
        });
        const text = await resp.text();
        const truncated = text.length > responseCap ? text.slice(0, responseCap) : text;
        return {
            status: resp.status,
            headers: Object.fromEntries(resp.headers.entries()),
            body: truncated,
            truncated: text.length > responseCap,
        };
    } catch (e) {
        if (isPrivateAddressError(e)) {
            return { error: 'Refused: target resolves to a private/internal address.' };
        }
        return { error: e.message || String(e) };
    } finally {
        clearTimeout(timer);
    }
}

module.exports = {
    runCode, isAvailable, loadError, defaultFetchHttp, describeCodeError, testBridges,
    SECRETS_NOT_CONFIGURED_NAME, SECRETS_NOT_CONFIGURED_MESSAGE,
};

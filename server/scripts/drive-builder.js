/**
 * Automation-builder harness — drives a REAL build end to end and judges it.
 *
 * WHY IT RUNS INSIDE THE SERVER CONTAINER: authentication needs the org's
 * connector tenant key, which is a bearer credential for the whole org. Read
 * here, it never touches the host disk or a shell history. The script mints a
 * short-lived HS256 JWT exactly as nextcloud-connector/src/auth.js does, which
 * server/auth/connectorJwt.js accepts globally — so it creates NO user row, NO
 * config row and NO session row (suppressSessionPersistence), and it
 * authenticates as the org user whose catalogue already carries the 14
 * Nextcloud app families.
 *
 * It exercises the real thing: chatStream.js's multi-round loop, the real
 * prompt and profile, the real validation feedback, against the real local
 * model. (The MCP endpoint does none of that — it is a plain JSON-RPC
 * dispatcher over applyToolCall.)
 *
 * A brief file can carry an `expect` block; the finished draft is walked
 * from the trigger and compared row by row (matchExpectation below), so a
 * run answers "did the model build THIS automation" instead of "did it finish".
 * scripts/builder-live-run.sh at the repo root copies this file and a brief
 * into the container and runs it.
 *
 * Usage, inside the container:
 *   node /tmp/drive-builder.js --brief-json /tmp/brief.json [--out /tmp/run.json] [--print-calls] [--cleanup]
 *   node /tmp/drive-builder.js --brief-file /tmp/brief.txt [--tier fast]
 *
 *   --brief-json <file>  { brief, tier?, expect? }; --tier on the command line wins over the file
 *   --print-calls        one line per tool call as it arrives: r<round> <name> ok|ERR repeat=<n> <error>
 *   --cleanup            on a pass, DELETE the draft automation; on any failure the draft stays and its id is printed
 *
 * Exit codes:
 *   0  the build matched the expectation (or there was none)
 *   1  mismatch — expected-vs-got per row and the failed calls are printed
 *   2  harness error — no brief, no tenant key, HTTP != 200
 *   3  the stream ended with an error or builder_aborted event
 * The full transcript is written to --out (default /tmp/builder-run.json)
 * whenever the stream opened, whatever the verdict.
 */

const http = require('http');
const fs = require('fs');
const { isDeepStrictEqual } = require('util');

// The script lives in /tmp inside the container, so bare resolution would not
// reach the server's modules. BEEFLOW_APP_DIR points elsewhere for a run
// against a checkout; the requires themselves happen inside main() so the
// unit tests can load this file without a server around.
const APP = process.env.BEEFLOW_APP_DIR || '/app';

const ORG = process.env.HARNESS_ORG || 'nc-nextcloud-nc-host-bee';
const NC_UID = process.env.HARNESS_NC_UID || 'admin';
const EMAIL = process.env.HARNESS_EMAIL || 'admin@example.com';
const PORT = Number(process.env.PORT || 3001);

const EXIT = { PASS: 0, MISMATCH: 1, HARNESS: 2, STREAM: 3 };

function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function flag(name) { return process.argv.includes(`--${name}`); }

// ── Expectation matching (pure) ─────────────────────────────────────────────

// A string expectation that starts with one of these roots and a segment
// (`steps.x…`, `steps["x"]…`) is a ref path; any other string is a literal
// value. Same roots validateAndFixBindings accepts.
const REF_ROOTS = new Set(['loop', 'steps', 'trigger', 'vars', 'secrets']);

// The run's path grammar (shared/expr/path.mjs, dependency-free). This file
// runs from /tmp inside the container, where a relative require does not
// reach the server: the checkout's copy first (tests), then the app's.
let pathGrammarModule = null;
function pathGrammar() {
    if (pathGrammarModule) return pathGrammarModule;
    for (const where of ['../shared/expr/path.mjs', `${APP}/shared/expr/path.mjs`]) {
        try { pathGrammarModule = require(where); return pathGrammarModule; } catch { /* next */ }
    }
    throw new Error('cannot load shared/expr/path.mjs — set BEEFLOW_APP_DIR to the server directory');
}

function isRefExpectation(s) {
    if (typeof s !== 'string') return false;
    const read = pathGrammar().readPath(s, 0);
    const root = read ? String(read.tokens[0].key) : '';
    return REF_ROOTS.has(root) && (s[root.length] === '.' || s[root.length] === '[');
}

/** Two spellings of one path (`items.0` / `items[0]`, `['k']` / `["k"]`) are the same ref. */
function samePath(a, b) {
    if (a === b) return true;
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const { canonicalPath } = pathGrammar();
    const ca = canonicalPath(a);
    return ca !== null && ca === canonicalPath(b);
}

/**
 * Resolve the placeholders of an expected path: `$k` → the id of chain step
 * k (with a `steps.` prefix when it opens the path), `$item` → the itemVar
 * of the step under test. Throws with a readable message when a placeholder
 * has nothing to resolve to — the caller reports that as the row's failure.
 */
function resolveExpectedPath(str, chainIds, itemVar) {
    let out = String(str);
    if (out.includes('$item')) {
        if (!itemVar) throw new Error('cannot resolve $item — the step has no forEach');
        out = out.split('$item').join(itemVar);
    }
    return out.replace(/\$(\d+)/g, (m, k, offset) => {
        const id = chainIds[Number(k)];
        if (!id) throw new Error(`${m} refers to chain step ${k}, but the chain has ${chainIds.length} step(s)`);
        return (offset === 0 ? 'steps.' : '') + id;
    });
}

function describeBinding(b) {
    if (b === undefined || b === null) return 'nothing';
    if (typeof b !== 'object') return JSON.stringify(b);
    if (b.kind === 'ref') return `ref ${b.path}`;
    if (b.kind === 'literal') return `literal ${JSON.stringify(b.value)}`;
    if (b.kind === 'template') return `template ${JSON.stringify(b.value)}`;
    return JSON.stringify(b);
}

/** null when the stored binding is what the (resolved) expectation asks for. */
function bindingMismatch(got, expected) {
    const isRef = isRefExpectation(expected);
    const want = isRef ? `ref ${expected}` : `literal ${JSON.stringify(expected)}`;
    const ok = isRef
        ? !!(got && got.kind === 'ref' && samePath(got.path, expected))
        : !!(got && got.kind === 'literal' && isDeepStrictEqual(got.value, expected));
    return ok ? null : `expected ${want}, got ${describeBinding(got)}`;
}

/** "missing a, b; extra c" — null when the sets agree. Order never matters. */
function setMismatch(expected, got) {
    const missing = expected.filter((k) => !got.includes(k));
    const extra = got.filter((k) => !expected.includes(k));
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.join(', ')}`);
    if (extra.length) parts.push(`extra ${extra.join(', ')}`);
    return parts.length ? parts.join('; ') : null;
}

/**
 * The steps reachable from the trigger by following single outgoing edges.
 * Stops (with a failure) at the first fork: the expectation format describes
 * one straight chain, and choosing a branch would hide the fork.
 */
function walkChain(def) {
    const failures = [];
    const steps = [];
    const byId = new Map((Array.isArray(def.steps) ? def.steps : []).map((s) => [s && s.id, s]));
    let cur = def.trigger && def.trigger.id;
    if (!cur) return { steps, failures: ['definition has no trigger'] };
    const seen = new Set([cur]);
    for (;;) {
        const out = (Array.isArray(def.edges) ? def.edges : []).filter((e) => e && e.from === cur);
        if (out.length === 0) break;
        if (out.length > 1) {
            failures.push(`branching at ${cur}: edges to ${out.map((e) => e.to + (e.label ? `(${e.label})` : '')).join(', ')} — the expectation describes one straight chain`);
            break;
        }
        const next = out[0].to;
        if (seen.has(next)) { failures.push(`cycle: ${cur} → ${next} was already visited`); break; }
        seen.add(next);
        const step = byId.get(next);
        if (!step) { failures.push(`edge ${cur} → ${next} points at a step that is not in def.steps`); break; }
        steps.push(step);
        cur = next;
    }
    return { steps, failures };
}

// The prompt (builderPrompt.js, both variants) directs a status filter
// between chained fan-outs — `item.status === 'success'` over the previous
// step's results — while a brief describes the chain WITHOUT it. Measured: a
// build that obeyed the prompt was reported MISMATCH (chain length 5 vs 4,
// every row after the filter shifted). The few-shot's own comment calls the
// filtered shape correct, so the gate is the side that was wrong.
const STATUS_FILTER_RE = /^\s*item\.status\s*===?\s*['"]success['"]\s*$/;

/**
 * Drop every walked `filter` step whose expr is the prompt-mandated status
 * filter, remembering `steps.<filterId>.output.items` → its arrayRef so the
 * step after it compares as if it read the unfiltered array. Any other filter
 * stays a real chain step (and fails the length check).
 */
function collapseStatusFilters(steps) {
    const aliases = new Map();
    const kept = [];
    for (const step of steps) {
        if (step && step.type === 'filter' && typeof step.expr === 'string' && STATUS_FILTER_RE.test(step.expr) && typeof step.arrayRef === 'string') {
            aliases.set(`steps.${step.id}.output.items`, step.arrayRef);
            continue;
        }
        kept.push(step);
    }
    return { steps: kept, aliases };
}

function compareRow(n, row, step, chainIds, aliases = new Map()) {
    const failures = [];
    const tag = `chain[${n}] (${step ? step.id : 'none'})`;
    if (!step) return [`${tag}: expected a ${row.type} step, got nothing`];
    const itemVar = step.forEach && step.forEach.itemVar ? step.forEach.itemVar : null;
    const resolve = (what, s) => {
        try { return resolveExpectedPath(s, chainIds, itemVar); } catch (e) { failures.push(`${tag} ${what}: ${e.message}`); return undefined; }
    };
    const scalar = (what, expected, got) => {
        if (expected !== undefined && got !== expected) failures.push(`${tag} ${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
    };

    scalar('type', row.type, step.type);
    scalar('tool', row.tool, step.tool);
    scalar('op', row.op, step.op);
    if (row.datatableId !== undefined) {
        const got = step.datatableId && typeof step.datatableId === 'object' && step.datatableId.kind === 'literal'
            ? step.datatableId.value : step.datatableId;
        scalar('datatableId', row.datatableId, got);
    }

    if (row.forEachOver !== undefined) {
        const want = resolve('forEach', row.forEachOver);
        const raw = step.forEach && step.forEach.overRef;
        // A fan-out over a collapsed status filter reads the filter's source.
        const got = typeof raw === 'string' && aliases.has(raw) ? aliases.get(raw) : raw;
        if (want !== undefined && got !== want) failures.push(`${tag} forEach: expected over ${want}, got ${got ? got : 'none'}`);
    } else if (step.forEach) {
        failures.push(`${tag} forEach: expected none, got over ${step.forEach.overRef}`);
    }

    if (row.inputs && typeof row.inputs === 'object') {
        for (const [key, expected] of Object.entries(row.inputs)) {
            const want = typeof expected === 'string' ? resolve(`inputs.${key}`, expected) : expected;
            if (want === undefined) continue;
            const mm = bindingMismatch(step.inputs && step.inputs[key], want);
            if (mm) failures.push(`${tag} inputs.${key}: ${mm}`);
        }
    }
    if (row.source !== undefined) {
        const want = typeof row.source === 'string' ? resolve('source', row.source) : row.source;
        if (want !== undefined) {
            const mm = bindingMismatch(step.source, want);
            if (mm) failures.push(`${tag} source: ${mm}`);
        }
    }
    if (Array.isArray(row.fields)) {
        const got = Array.isArray(step.fields) ? step.fields.map((f) => f && f.name).filter(Boolean) : [];
        const mm = setMismatch(row.fields, got);
        if (mm) failures.push(`${tag} fields: ${mm}`);
    }
    if (Array.isArray(row.valuesKeys)) {
        const got = step.values && typeof step.values === 'object' ? Object.keys(step.values) : [];
        const mm = setMismatch(row.valuesKeys, got);
        if (mm) failures.push(`${tag} values keys: ${mm}`);
    }
    return failures;
}

/**
 * The automation's name as the transcript last reported it: the last `metadata`
 * event (sent after every builder_set_metadata and after the server named an
 * untitled draft itself), else the finalize echo, else the last
 * builder_set_metadata echo. Null when nothing named it.
 */
function finalTitle(events) {
    const evs = Array.isArray(events) ? events : [];
    const meta = [...evs].reverse().find((e) => e.event === 'metadata' && e.data && typeof e.data.title === 'string');
    if (meta) return meta.data.title;
    const fin = [...evs].reverse().find((e) => e.event === 'tool_call' && e.data && e.data.name === 'builder_finalize' && e.data.result && e.data.result.automation && typeof e.data.result.automation.title === 'string');
    if (fin) return fin.data.result.automation.title;
    const set = [...evs].reverse().find((e) => e.event === 'tool_call' && e.data && e.data.name === 'builder_set_metadata' && e.data.result && typeof e.data.result.title === 'string');
    return set ? set.data.result.title : null;
}

/** Prompt tokens of the FIRST round — the prefix the local box prefilled. */
function firstRoundPromptTokens(events) {
    const first = (Array.isArray(events) ? events : []).find((e) => e.event === 'usage' && e.data);
    if (!first) return null;
    const n = Number(first.data.prompt_tokens);
    return Number.isFinite(n) ? n : null;
}

/**
 * Judge a finished build: `def` is the last draft definition, `events` the
 * SSE transcript ({event, data} rows), `expect` the brief's block —
 *   chain[n]: { type, tool?, op?, datatableId?, inputs?, forEachOver?, source?, fields?, valuesKeys? }
 *   finalized?, maxFailedCalls?, maxRounds?, titled?, maxFirstRoundPromptTokens?
 * Pure. Returns { ok, failures: string[] }, one readable line per mismatch.
 */
function matchExpectation(def, events, expect) {
    if (!expect || typeof expect !== 'object') return { ok: true, failures: [] };
    const failures = [];
    const evs = Array.isArray(events) ? events : [];

    if (Array.isArray(expect.chain)) {
        if (!def || typeof def !== 'object') {
            failures.push('no draft definition was emitted, so the chain cannot be checked');
        } else {
            const walked = walkChain(def);
            failures.push(...walked.failures);
            // The prompt says "filter first"; the brief describes the shape
            // without it (see collapseStatusFilters).
            const { steps, aliases } = collapseStatusFilters(walked.steps);
            const chainIds = steps.map((s) => s.id);
            if (steps.length !== expect.chain.length) {
                failures.push(`chain length: expected ${expect.chain.length} (${expect.chain.map((r) => r.type).join(', ')}), got ${steps.length} (${steps.map((s) => s.type).join(', ')})`);
            }
            expect.chain.forEach((row, n) => failures.push(...compareRow(n, row || {}, steps[n], chainIds, aliases)));
        }
    }

    const done = evs.find((e) => e.event === 'done');
    if (expect.finalized !== undefined) {
        const got = !!(done && done.data && done.data.finalized);
        if (got !== !!expect.finalized) failures.push(`finalized: expected ${!!expect.finalized}, got ${got}`);
    }
    // The Playbook fill phase runs the automation by hand: an event trigger
    // would make that run "skipped" (2026-09-13).
    if (expect.triggerKind !== undefined) {
        const got = def && def.trigger ? def.trigger.kind : null;
        if (got !== expect.triggerKind) failures.push(`trigger kind: expected ${expect.triggerKind}, got ${got}`);
    }
    if (expect.maxFailedCalls !== undefined) {
        const failed = evs
            .filter((e) => e.event === 'tool_call' && e.data && e.data.result && typeof e.data.result === 'object' && e.data.result.error)
            .map((e) => `${e.data.name}: ${String(e.data.result.error).replace(/\s+/g, ' ').slice(0, 120)}`);
        if (failed.length > expect.maxFailedCalls) failures.push(`failed calls: expected at most ${expect.maxFailedCalls}, got ${failed.length} — ${failed.join('; ')}`);
    }
    if (expect.maxRounds !== undefined) {
        const rounds = done && done.data && typeof done.data.iterations === 'number'
            ? done.data.iterations
            : evs.filter((e) => e.event === 'usage').length;
        if (rounds > expect.maxRounds) failures.push(`rounds: expected at most ${expect.maxRounds}, got ${rounds}`);
    }
    // The automation has a real name: not the default, at most 60 chars. The
    // model's builder_set_metadata or the server's fallback — either counts,
    // because either is what the person sees.
    if (expect.titled) {
        const title = finalTitle(evs);
        if (!title || !title.trim()) failures.push('titled: nothing named the automation (no metadata event, no set_metadata, no finalize title)');
        else if (title.trim() === 'Untitled automation') failures.push('titled: the automation is still "Untitled automation"');
        else if (title.length > 60) failures.push(`titled: the title is ${title.length} chars, expected at most 60 — "${title}"`);
    }
    // The first-round prefill, as the model reported it: the measure of the
    // small-band diet (system + tools + few-shots + catalog).
    if (expect.maxFirstRoundPromptTokens !== undefined) {
        const n = firstRoundPromptTokens(evs);
        if (n === null) failures.push('first-round prompt tokens: no usage event carried prompt_tokens');
        else if (n > expect.maxFirstRoundPromptTokens) failures.push(`first-round prompt tokens: expected at most ${expect.maxFirstRoundPromptTokens}, got ${n}`);
    }
    return { ok: failures.length === 0, failures };
}

/** The --print-calls row for one tool_call event. */
function formatCallLine(round, data) {
    const r = data && data.result;
    const failed = !!(r && typeof r === 'object' && r.error);
    const repeat = (r && typeof r === 'object' && r._repeated) || 1;
    const err = failed ? ` ${String(r.error).replace(/\s+/g, ' ').slice(0, 80)}` : '';
    return `r${round} ${data && data.name} ${failed ? 'ERR' : 'ok'} repeat=${repeat}${err}`;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

/** POST the brief and collect the SSE stream. Rejects on any non-200 answer. */
function streamBuild({ headers, body, onEvent }) {
    const t0 = Date.now();
    const events = [];
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/automation/builder/stream', method: 'POST', headers }, (res) => {
            if (res.statusCode !== 200) {
                let b = ''; res.on('data', (c) => { b += c; });
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${b.slice(0, 400)}`)));
                return;
            }
            let buf = '', ev = 'message';
            res.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('event: ')) { ev = line.slice(7).trim(); continue; }
                    if (!line.startsWith('data: ')) continue;
                    let data = null;
                    try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
                    events.push({ at: Date.now() - t0, event: ev, data });
                    if (onEvent) onEvent(ev, data);
                }
            });
            res.on('end', () => resolve({ events, t0 }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
    });
}

/** DELETE /api/automation/:id — routes/automation/crud.js's delete, as the same user. */
function deleteDraft(id, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: `/api/automation/${encodeURIComponent(id)}`, method: 'DELETE',
            headers: { ...headers, 'Accept': 'application/json' },
        }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 300) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

// ── Summary ─────────────────────────────────────────────────────────────────

function summarise(events, t0) {
    const toolCalls = events.filter((e) => e.event === 'tool_call');
    const usage = events.filter((e) => e.event === 'usage');
    const done = events.find((e) => e.event === 'done');
    const errs = events.filter((e) => e.event === 'error');
    const aborted = events.find((e) => e.event === 'builder_aborted');
    const lastDraft = [...events].reverse().find((e) => e.event === 'draft');
    const validations = events.filter((e) => e.event === 'validation_errors');
    const lastValidation = validations[validations.length - 1];

    // tool calls per round: `usage` is emitted once per round, so bucket by it
    const perRound = [];
    let bucket = [];
    for (const e of events) {
        if (e.event === 'tool_call') bucket.push(e.data && e.data.name);
        if (e.event === 'usage') { perRound.push(bucket); bucket = []; }
    }
    if (bucket.length) perRound.push(bucket);

    const counts = {};
    for (const tc of toolCalls) counts[tc.data?.name] = (counts[tc.data?.name] || 0) + 1;

    const failedCalls = toolCalls
        .filter((tc) => tc.data && tc.data.result && typeof tc.data.result === 'object' && tc.data.result.error)
        .map((tc) => ({ name: tc.data.name, error: String(tc.data.result.error).slice(0, 300) }));

    const def = lastDraft?.data?.definition || null;
    return {
        def,
        done,
        errs,
        aborted,
        failedCalls,
        summary: {
            rounds: done?.data?.iterations ?? usage.length,
            hitIterationCap: !!aborted || (done?.data?.iterations >= 24),
            finalized: !!done?.data?.finalized,
            wallClockMs: Date.now() - t0,
            toolCallTotal: toolCalls.length,
            toolCallsPerRound: perRound.map((b) => b.length),
            callsByName: counts,
            failedCalls,
            errors: errs.map((e) => e.data),
            aborted: aborted?.data || null,
            finalValidation: lastValidation?.data || null,
            finalStepCount: Array.isArray(def?.steps) ? def.steps.length : null,
            finalSteps: Array.isArray(def?.steps)
                ? def.steps.map((s) => ({ id: s.id, type: s.type, tool: s.tool, forEach: s.forEach?.overRef, bodyIds: Array.isArray(s.body) ? s.body.map((b) => b.id) : undefined }))
                : null,
            finalEdges: Array.isArray(def?.edges) ? def.edges.map((e) => `${e.from}→${e.to}${e.label ? `(${e.label})` : ''}`) : null,
            usageTotals: done?.data?.usage || null,
            title: finalTitle(events),
            firstRoundPromptTokens: firstRoundPromptTokens(events),
        },
    };
}

// ── Main ────────────────────────────────────────────────────────────────────

function readBrief() {
    const jsonFile = arg('brief-json', null);
    if (jsonFile) {
        const parsed = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        if (!parsed || typeof parsed.brief !== 'string' || !parsed.brief.trim()) {
            throw new Error(`${jsonFile} has no "brief" string`);
        }
        return { brief: parsed.brief.trim(), tier: arg('tier', parsed.tier || 'fast'), expect: parsed.expect || null };
    }
    const briefFile = arg('brief-file', null);
    const brief = briefFile ? fs.readFileSync(briefFile, 'utf8').trim() : arg('brief', null);
    return { brief, tier: arg('tier', 'fast'), expect: null };
}

async function main() {
    const { brief, tier, expect } = readBrief();
    if (!brief) { console.error('need --brief-json <file>, --brief-file <path> or --brief "<text>"'); return EXIT.HARNESS; }
    const outPath = arg('out', '/tmp/builder-run.json');
    const printCalls = flag('print-calls');
    const cleanup = flag('cleanup');

    const jwt = require(APP + '/node_modules/jsonwebtoken');
    const key = await require(APP + '/stores/configStore').getSecret(`connector_tenant_key_${ORG}`);
    if (!key) { console.error(`no tenant key for org ${ORG}`); return EXIT.HARNESS; }

    const token = jwt.sign(
        { sub: NC_UID, email: EMAIL, name: NC_UID, nc_admin: true },
        key,
        { algorithm: 'HS256', issuer: 'nextcloud-connector', audience: 'beeflow.nl', expiresIn: 1800 },
    );
    const headers = {
        'Authorization': `Bearer ${token}`,
        'X-Beeflow-Source': 'nextcloud-connector',
        'X-Beeflow-NC-Uid': NC_UID,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
    };

    const body = JSON.stringify({ message: brief, modelTier: tier, timezone: 'Europe/Amsterdam', history: [] });

    // Rounds are counted from round_start, which chatStream sends BEFORE the
    // model call — so a call printed under r3 was made in the third round
    // even when the round never reaches its usage event.
    let round = 0;
    const onEvent = (ev, data) => {
        if (ev === 'round_start') round += 1;
        if (printCalls && ev === 'tool_call') console.log(formatCallLine(round, data));
    };

    const { events, t0 } = await streamBuild({ headers, body, onEvent });

    const { def, done, errs, aborted, failedCalls, summary } = summarise(events, t0);
    fs.writeFileSync(outPath, JSON.stringify({ summary, events }, null, 1));
    console.log(JSON.stringify(summary, null, 1));
    console.log(`\n(full transcript: ${outPath}, ${events.length} events)`);

    const draftId = done?.data?.automationId || null;
    if (errs.length || aborted) {
        for (const e of errs) console.error(`stream error: ${e.data && e.data.error ? e.data.error : JSON.stringify(e.data)}`);
        if (aborted) console.error(`builder aborted: ${aborted.data && aborted.data.reason}`);
        if (draftId) console.error(`draft kept: ${draftId}`);
        return EXIT.STREAM;
    }

    const verdict = matchExpectation(def, events, expect);
    if (!verdict.ok) {
        console.error(`\nEXPECTATION MISMATCH (${verdict.failures.length}):`);
        for (const f of verdict.failures) console.error(`  - ${f}`);
        if (failedCalls.length) {
            console.error(`failed calls (${failedCalls.length}):`);
            for (const fc of failedCalls) console.error(`  - ${fc.name}: ${fc.error}`);
        }
        if (draftId) console.error(`draft kept: ${draftId}`);
        return EXIT.MISMATCH;
    }

    console.log(expect ? '\nPASS: the build matches the expectation' : '\nPASS: no expectation to check');
    if (cleanup && draftId) {
        const r = await deleteDraft(draftId, headers);
        if (r.status === 200) console.log(`draft ${draftId} deleted`);
        else console.error(`warning: could not delete draft ${draftId} (HTTP ${r.status}: ${r.body}) — remove it by hand`);
    } else if (draftId) {
        console.log(`draft kept: ${draftId}`);
    }
    return EXIT.PASS;
}

module.exports = { matchExpectation, formatCallLine, resolveExpectedPath, walkChain, bindingMismatch, finalTitle, firstRoundPromptTokens, EXIT };

if (require.main === module) {
    // configStore opens a DB pool, so the process would otherwise hang on an idle
    // handle long after the transcript is written.
    main().then((code) => process.exit(code))
        .catch((e) => { console.error('HARNESS FAILED:', e.message); process.exit(EXIT.HARNESS); });
}

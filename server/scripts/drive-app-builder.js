/**
 * App Studio builder harness — drives a REAL app build end to end, the way
 * drive-builder.js drives an automation build, and judges it against a brief's
 * expectation. The live-run GATE for any App Studio builder change: "tests
 * pass" is not done; the app on the canvas is.
 *
 * WHY IT RUNS INSIDE THE SERVER CONTAINER: authentication needs the org's
 * connector tenant key, a bearer credential for the whole org. Read here, it
 * never touches the host disk or a shell history. The script mints a
 * short-lived HS256 JWT exactly as nextcloud-connector/src/auth.js does,
 * which server/auth/connectorJwt.js accepts — no user row, no session row —
 * and authenticates as the org user who linked the Facturen mirror in
 * Studio > Datatables (app_link_datatable resolves what the OWNER can see).
 *
 * Usage, inside the container (scripts/app-builder-live-run.sh does the copy):
 *   node /tmp/drive-app-builder.js --brief-json /tmp/brief.json [--out /tmp/app-run.json] [--print-calls] [--cleanup]
 *   node /tmp/drive-app-builder.js --brief "<text>" [--tier fast] [--app <appId>]
 *
 *   --brief-json  { brief | turns:[…], tier?, appId?, planMode?, expect? }
 *   --print-calls one line per tool call as it arrives: r<round> <name> ok|ERR repeat=<n> <error>
 *   --cleanup     on a pass, DELETE the app; on any failure it stays and its id is printed
 *
 * expect = {
 *   finalized, maxFailedCalls, maxRounds, maxRepeated,
 *   linkedTable: { key?, name?, minRows? },          // a linked model table with live rows
 *   components: ['stat', 'chart', 'data_grid', …],    // types that must exist somewhere
 *   minComponents, screens,                           // counts
 *   noTools: ['app_seed_records', 'app_upsert_table'] // calls that must NOT succeed
 *   name: { notUntitled: true, matches?: '^Factur' }, // the app was NAMED (definition.meta.name)
 *   maxPromptChars: 62000,                            // round 0's round_start.promptChars (the prefix diet):
 *                                                     // measured 49.0–49.7k on the small band with a stub owner
 *                                                     // context (print-model-prompt.js, 2026-09-18); the gap is
 *                                                     // room for 40 automation lines + documents in the OWNER CONTEXT
 *                                                     // note, and still far below the pre-diet ~90k
 * }
 * Exit codes: 0 pass · 1 mismatch (app kept, id printed) · 2 harness error · 3 stream error.
 */

const http = require('http');
const fs = require('fs');

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

/** Every component node in a definition, with its screen. */
function componentsOf(def) {
    const out = [];
    const walk = (children, screenId) => {
        for (const c of children || []) {
            if (c && typeof c === 'object') { out.push({ id: c.id, type: c.type, screenId, props: c.props || null }); if (Array.isArray(c.children)) walk(c.children, screenId); }
        }
    };
    for (const scr of (def && Array.isArray(def.screens)) ? def.screens : []) for (const sec of scr.sections || []) walk(sec.children, scr.id);
    return out;
}

function matchExpectation(def, events, expect) {
    if (!expect || typeof expect !== 'object') return { ok: true, failures: [] };
    const failures = [];
    const evs = Array.isArray(events) ? events : [];
    const done = evs.find((e) => e.event === 'done');
    const calls = evs.filter((e) => e.event === 'tool_call' && e.data);

    if (expect.finalized !== undefined) {
        const got = !!(done && done.data && done.data.finalized);
        if (got !== !!expect.finalized) failures.push(`finalized: expected ${!!expect.finalized}, got ${got}`);
    }
    if (expect.maxFailedCalls !== undefined) {
        const failed = calls.filter((e) => e.data.ok === false).map((e) => `${e.data.name}: ${String(e.data.error || e.data.summary || '').replace(/\s+/g, ' ').slice(0, 120)}`);
        if (failed.length > expect.maxFailedCalls) failures.push(`failed calls: expected at most ${expect.maxFailedCalls}, got ${failed.length} — ${failed.join('; ')}`);
    }
    // The app was named — by the model (app_set_meta) or the finalize net.
    // "Untitled app" on a finished build is the failure this checks for.
    if (expect.name && typeof expect.name === 'object') {
        const got = def && def.meta && typeof def.meta.name === 'string' ? def.meta.name.trim() : '';
        if (!def) failures.push('no draft definition was emitted, so the app name cannot be checked');
        else {
            if (expect.name.notUntitled && (!got || got === 'Untitled app')) failures.push(`name: expected a real app name, got ${JSON.stringify(got || '')}`);
            if (typeof expect.name.matches === 'string' && !new RegExp(expect.name.matches, 'i').test(got)) failures.push(`name: expected /${expect.name.matches}/i, got ${JSON.stringify(got)}`);
        }
    }
    // The first round's request size — what a fresh session reads before the
    // user's first word. round_start.promptChars is JSON.stringify(messages).
    if (expect.maxPromptChars !== undefined) {
        const first = evs.find((e) => e.event === 'round_start' && e.data && Number.isFinite(Number(e.data.promptChars)));
        if (!first) failures.push('no round_start with promptChars was emitted, so the prompt size cannot be checked');
        else if (Number(first.data.promptChars) > expect.maxPromptChars) failures.push(`promptChars: expected at most ${expect.maxPromptChars} on round 0, got ${first.data.promptChars}`);
    }
    if (expect.maxRounds !== undefined) {
        const rounds = evs.filter((e) => e.event === 'round_start').length || evs.filter((e) => e.event === 'usage').length;
        if (rounds > expect.maxRounds) failures.push(`rounds: expected at most ${expect.maxRounds}, got ${rounds}`);
    }
    if (expect.maxRepeated !== undefined) {
        let max = 0;
        for (const e of calls) { const m = /"_repeated":(\d+)/.exec(String(e.data.result || '')); if (m) max = Math.max(max, Number(m[1])); }
        if (max > expect.maxRepeated) failures.push(`repeated identical rejections: expected at most ${expect.maxRepeated}, got ${max}`);
    }
    if (Array.isArray(expect.noTools)) {
        for (const name of expect.noTools) {
            if (calls.some((e) => e.data.name === name && e.data.ok !== false)) failures.push(`tool ${name} must not succeed in this build, but did`);
        }
    }
    const lastModel = [...evs].reverse().find((e) => e.event === 'data_model' && e.data && Array.isArray(e.data.tables));
    if (expect.linkedTable) {
        const want = expect.linkedTable;
        const tables = lastModel ? lastModel.data.tables : [];
        const hit = tables.find((t) => t && t.linked && (!want.key || t.key === want.key) && (!want.name || String(t.name).toLowerCase() === String(want.name).toLowerCase()));
        if (!hit) failures.push(`linked table ${JSON.stringify(want)}: none in the last data_model event (${tables.map((t) => `${t.key}${t.linked ? ' linked' : ''}`).join(', ') || 'no tables'})`);
        else {
            if (want.minRows !== undefined && !(hit.rowCount >= want.minRows)) failures.push(`linked table ${hit.key}: expected at least ${want.minRows} live rows, got ${hit.rowCount}`);
            // The approvals phase re-links writable (onDecided writes status).
            if (want.mode !== undefined && (hit.linked && hit.linked.mode) !== want.mode) failures.push(`linked table ${hit.key}: expected mode ${want.mode}, got ${hit.linked && hit.linked.mode}`);
        }
    }
    // Step kinds that must occur in some action (top level or nested in a sequence).
    if (Array.isArray(expect.actionSteps)) {
        const kinds = new Set();
        const walk = (step, depth = 0) => {
            if (!step || typeof step !== 'object' || depth > 6) return;
            if (typeof step.kind === 'string') kinds.add(step.kind);
            for (const list of [step.steps, step.then, step.else]) if (Array.isArray(list)) list.forEach((s) => walk(s, depth + 1));
            if (Array.isArray(step.cases)) step.cases.forEach((c) => c && Array.isArray(c.steps) && c.steps.forEach((s) => walk(s, depth + 1)));
        };
        for (const a of Object.values((def && def.actions) || {})) walk(a);
        for (const k of expect.actionSteps) if (!kinds.has(k)) failures.push(`action step ${k}: none in any action (have ${[...kinds].join(', ') || 'none'})`);
    }
    // Own tables (2026-09-13 brief): at least N tables the app created itself,
    // each with rows — the invoice-tracker turn invented ids and created none.
    if (expect.ownTables) {
        const want = expect.ownTables;
        const tables = lastModel ? lastModel.data.tables.filter((t) => t && !t.linked) : [];
        if (want.min !== undefined && tables.length < want.min) failures.push(`own tables: expected at least ${want.min}, got ${tables.length} (${tables.map((t) => t.key).join(', ') || 'none'})`);
        if (want.minRows !== undefined) {
            const empty = tables.filter((t) => !(Number(t.rowCount) >= want.minRows));
            if (empty.length) failures.push(`own tables with fewer than ${want.minRows} rows: ${empty.map((t) => `${t.key}=${t.rowCount ?? 0}`).join(', ')}`);
        }
    }
    if (Array.isArray(expect.components) || expect.minComponents !== undefined || expect.screens !== undefined || expect.minScreens !== undefined || expect.uniqueFormNames) {
        if (!def) failures.push('no draft definition was emitted, so components cannot be checked');
        else {
            const comps = componentsOf(def);
            const types = new Set(comps.map((c) => c.type));
            for (const t of expect.components || []) if (!types.has(t)) failures.push(`component type ${t}: none on any screen (have ${[...types].join(', ') || 'none'})`);
            if (expect.minComponents !== undefined && comps.length < expect.minComponents) failures.push(`components: expected at least ${expect.minComponents}, got ${comps.length}`);
            if (expect.screens !== undefined && (def.screens || []).length !== expect.screens) failures.push(`screens: expected ${expect.screens}, got ${(def.screens || []).length}`);
            if (expect.minScreens !== undefined && (def.screens || []).length < expect.minScreens) failures.push(`screens: expected at least ${expect.minScreens}, got ${(def.screens || []).length}`);
            if (expect.uniqueFormNames) {
                // A form name is unique per screen; a duplicate is the resent batch that landed twice.
                const seen = new Map();
                for (const c of comps) {
                    if (c.type !== 'form') continue;
                    const key = `${c.screenId}:${(c.props && c.props.name) || c.id}`;
                    seen.set(key, (seen.get(key) || 0) + 1);
                }
                const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([k, n]) => `${k} ×${n}`);
                if (dupes.length) failures.push(`duplicate forms on one screen: ${dupes.join(', ')}`);
            }
        }
    }
    return { ok: failures.length === 0, failures };
}

function formatCallLine(round, data) {
    const failed = !!(data && data.ok === false);
    const m = /"_repeated":(\d+)/.exec(String((data && data.result) || ''));
    const repeat = m ? Number(m[1]) : 1;
    const err = failed ? ` ${String(data.error || data.summary || '').replace(/\s+/g, ' ').slice(0, 80)}` : '';
    return `r${round} ${data && data.name} ${failed ? 'ERR' : 'ok'} repeat=${repeat}${err}`;
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function streamBuild({ headers, body, onEvent }) {
    const t0 = Date.now();
    const events = [];
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/studio-apps/builder/stream', method: 'POST', headers }, (res) => {
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
                    if (onEvent) { try { onEvent(ev, data); } catch (_) { /* printing never breaks the run */ } }
                }
            });
            res.on('end', () => resolve({ events, t0 }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body);
    });
}

function deleteApp(id, headers) {
    return new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: `/api/studio-apps/${encodeURIComponent(id)}`, method: 'DELETE', headers: { Authorization: headers.Authorization, 'X-Beeflow-Source': headers['X-Beeflow-Source'], 'X-Beeflow-NC-Uid': headers['X-Beeflow-NC-Uid'] } }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: b.slice(0, 200) }));
        });
        req.on('error', (e) => resolve({ status: 0, body: e.message }));
        req.end();
    });
}

function readBrief() {
    const jsonFile = arg('brief-json', null);
    if (jsonFile) {
        const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        const turns = Array.isArray(j.turns) ? j.turns : (j.brief ? [j.brief] : []);
        return { turns, tier: arg('tier', j.tier || 'fast'), expect: j.expect || null, appId: arg('app', j.appId || null), planMode: j.planMode || 'never' };
    }
    const briefFile = arg('brief-file', null);
    const brief = briefFile ? fs.readFileSync(briefFile, 'utf8').trim() : arg('brief', null);
    return { turns: brief ? [brief] : [], tier: arg('tier', 'fast'), expect: null, appId: arg('app', null), planMode: arg('plan-mode', 'never') };
}

async function main() {
    const { turns, tier, expect, planMode } = readBrief();
    let appId = readBrief().appId;
    if (!turns.length) { console.error('need --brief-json <file>, --brief-file <path> or --brief "<text>"'); return EXIT.HARNESS; }
    const outPath = arg('out', '/tmp/app-builder-run.json');
    const printCalls = flag('print-calls');
    const cleanup = flag('cleanup');
    const { summariseBuilderRun } = require(APP + '/appStudio/builderRunSummary');

    const jwt = require(APP + '/node_modules/jsonwebtoken');
    const key = await require(APP + '/stores/configStore').getSecret(`connector_tenant_key_${ORG}`);
    if (!key) { console.error(`no tenant key for org ${ORG}`); return EXIT.HARNESS; }
    const token = jwt.sign(
        { sub: NC_UID, email: EMAIL, name: NC_UID, nc_admin: true },
        key,
        { algorithm: 'HS256', issuer: 'nextcloud-connector', audience: 'beeflow.nl', expiresIn: 3600 },
    );
    const headers = {
        'Authorization': `Bearer ${token}`,
        'X-Beeflow-Source': 'nextcloud-connector',
        'X-Beeflow-NC-Uid': NC_UID,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
    };

    const runs = [];
    let builderSessionId = null;
    let lastDef = null;
    let allEvents = [];
    for (const [i, brief] of turns.entries()) {
        let round = 0;
        const onEvent = (ev, data) => {
            if (ev === 'round_start') round += 1;
            if (printCalls && ev === 'tool_call') console.log(formatCallLine(round, data));
        };
        const body = JSON.stringify({ message: brief, appId: appId || undefined, builderSessionId: builderSessionId || undefined, modelTier: tier, planMode, timezone: 'Europe/Amsterdam' });
        const { events } = await streamBuild({ headers, body, onEvent });
        const session = events.find((e) => e.event === 'builder_session');
        if (session && session.data) { builderSessionId = session.data.sessionId || builderSessionId; appId = session.data.appId || appId; }
        const done = events.find((e) => e.event === 'done');
        if (done && done.data && done.data.appId) appId = done.data.appId;
        const lastDraft = [...events].reverse().find((e) => e.event === 'draft');
        if (lastDraft && lastDraft.data) lastDef = lastDraft.data.definition || lastDef;
        const summary = summariseBuilderRun(events);
        summary.appId = appId;
        runs.push({ brief, summary, events });
        allEvents = allEvents.concat(events);
        console.log(`\n── turn ${i + 1}/${turns.length} ──`);
        console.log(JSON.stringify(summary, null, 1));
    }
    fs.writeFileSync(outPath, JSON.stringify({ runs }, null, 1));
    console.log(`\n(full transcript: ${outPath}; appId ${appId || '-'}; session ${builderSessionId || '-'})`);

    const errs = allEvents.filter((e) => e.event === 'error');
    if (errs.length) {
        for (const e of errs) console.error(`stream error: ${e.data && (e.data.message || e.data.error) ? (e.data.message || e.data.error) : JSON.stringify(e.data)}`);
        if (appId) console.error(`app kept: ${appId}`);
        return EXIT.STREAM;
    }
    // Judge the LAST turn's events against the expectation (a two-turn brief
    // expects the end state), with the final definition.
    const judged = runs.length ? runs[runs.length - 1].events : [];
    const verdict = matchExpectation(lastDef, judged, expect);
    if (!verdict.ok) {
        console.error(`\nEXPECTATION MISMATCH (${verdict.failures.length}):`);
        for (const f of verdict.failures) console.error(`  - ${f}`);
        if (appId) console.error(`app kept: ${appId}`);
        return EXIT.MISMATCH;
    }
    console.log(expect ? '\nPASS: the build matches the expectation' : '\nPASS: no expectation to check');
    if (cleanup && appId) {
        const r = await deleteApp(appId, headers);
        if (r.status === 200 || r.status === 204) console.log(`app ${appId} deleted`);
        else console.error(`warning: could not delete app ${appId} (HTTP ${r.status}: ${r.body}) — remove it by hand`);
    } else if (appId) {
        console.log(`app kept: ${appId}`);
    }
    return EXIT.PASS;
}

module.exports = { matchExpectation, formatCallLine, componentsOf, EXIT };

if (require.main === module) {
    // configStore opens a DB pool, so the process would otherwise hang on an idle
    // handle long after the transcript is written.
    main().then((code) => process.exit(code))
        .catch((e) => { console.error('HARNESS FAILED:', e.message); process.exit(EXIT.HARNESS); });
}

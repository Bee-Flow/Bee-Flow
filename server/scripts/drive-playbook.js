/**
 * Playbook harness — drives ONE playbook end to end through the real API
 * and the two real builder streams, and judges it against a case file.
 *
 * Runs INSIDE the server container for the same reason drive-builder.js
 * does: the connector tenant key mints the JWT here and never leaves. It is
 * the page's client (PlaybookRun.jsx) with a machine at the keyboard:
 *   - a server-run phase (table, fill, design) → POST …/phases/<key>/run, poll while running
 *   - a builder phase (automation, app, app_turn) → PATCH running, open the builder
 *     stream with the phase's brief, PATCH awaiting (finalized) or failed
 *   - an awaiting phase → Continue (PATCH done), or Skip when the case says so
 *   - a failed phase → the case's policy: retry once, skip, or stop
 * plus scenario hooks (stop mid-phase and resume) and a "describe" door
 * (POST /recipes/compose first, then create from the document).
 *
 * Usage, inside the container (scripts/playbook-live-run.sh does the copy):
 *   node /tmp/drive-playbook.js --case /tmp/case.json [--out /tmp/playbook-run.json] [--print-calls]
 *
 * A case file:
 *   { id, title, recipeId? | describe?, options: { tableMode, datatableName?, inputs, tier, approverGroupId? },
 *     skip: ['fill'], onFail: { automation: 'retry_once'|'skip'|'stop', … }, scenario: 'stop_resume_automation'?,
 *     until: 'app'?  (stop after this phase landed — matched on the phase key OR kind; cheap partial cases),
 *     expect: { compose?: { kinds:[…] }, phases?: { key: status|[statuses] }, minRows?, automation?, app?, approvals? } }
 *   expect.automation / expect.app / expect.approvals are the drive-builder.js and
 *   drive-app-builder.js expectation blocks, judged on the same definitions.
 *
 * Exit codes: 0 pass · 1 mismatch · 2 harness error · 3 a stream/API error ended the run.
 * The report (phases, timings, calls, verdict, every stream's events) is
 * written to --out whatever the verdict.
 */

const http = require('http');
const fs = require('fs');

const APP = process.env.BEEFLOW_APP_DIR || '/app';
const ORG = process.env.HARNESS_ORG || 'nc-nextcloud-nc-host-bee';
const NC_UID = process.env.HARNESS_NC_UID || 'admin';
const EMAIL = process.env.HARNESS_EMAIL || 'admin@example.com';
const PORT = Number(process.env.PORT || 3001);
const EXIT = { PASS: 0, MISMATCH: 1, HARNESS: 2, STREAM: 3 };
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS || 20 * 60_000);
const POLL_MS = 3000;
const SERVER_PHASE_TIMEOUT_MS = 20 * 60_000;

function arg(name, dflt) { const i = process.argv.indexOf(`--${name}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt; }
function flag(name) { return process.argv.includes(`--${name}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kindOf = (p) => (p && (p.kind || (p.key === 'approvals' ? 'app_turn' : p.key))) || null;
const ACTIONABLE = new Set(['ready', 'running', 'awaiting', 'failed']);
const nextActionable = (phases) => (phases || []).find((p) => ACTIONABLE.has(p.status)) || null;
const phaseByKey = (phases, key) => (phases || []).find((p) => p.key === key) || null;

// ── HTTP ────────────────────────────────────────────────────────────────────

function request(method, path, body, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path, method, headers: { ...headers, Accept: 'application/json' } }, (res) => {
            let b = ''; res.on('data', (c) => { b += c; });
            res.on('end', () => { let json = null; try { json = b ? JSON.parse(b) : null; } catch { json = { raw: b.slice(0, 500) }; } resolve({ status: res.statusCode, body: json }); });
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

function stream(path, body, headers, onEvent) {
    const t0 = Date.now();
    const events = [];
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'POST', headers: { ...headers, Accept: 'text/event-stream' } }, (res) => {
            if (res.statusCode !== 200) { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => reject(new Error(`HTTP ${res.statusCode} on ${path}: ${b.slice(0, 400)}`))); return; }
            let buf = ''; let ev = 'message';
            res.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                const lines = buf.split('\n'); buf = lines.pop();
                for (const line of lines) {
                    if (line.startsWith('event: ')) { ev = line.slice(7).trim(); continue; }
                    if (!line.startsWith('data: ')) continue;
                    let data = null; try { data = JSON.parse(line.slice(6)); } catch { data = line.slice(6); }
                    events.push({ at: Date.now() - t0, event: ev, data });
                    if (onEvent) onEvent(ev, data);
                }
            });
            res.on('end', () => resolve({ events, ms: Date.now() - t0 }));
            res.on('error', reject);
        });
        req.setTimeout(STREAM_TIMEOUT_MS, () => { req.destroy(new Error(`stream timeout after ${STREAM_TIMEOUT_MS} ms`)); });
        req.on('error', reject);
        req.end(JSON.stringify(body));
    });
}

// ── The run ─────────────────────────────────────────────────────────────────

class Harness {
    constructor(headers, caseFile, printCalls) {
        this.h = headers; this.c = caseFile; this.printCalls = printCalls;
        this.report = { id: caseFile.id, title: caseFile.title, startedAt: new Date().toISOString(), steps: [], streams: [], notes: [], errors: [] };
        this.pb = null;
    }

    note(text) { this.report.notes.push(text); console.log(`  · ${text}`); }
    step(kind, detail) { const s = { at: new Date().toISOString(), kind, ...detail }; this.report.steps.push(s); return s; }

    async api(method, path, body) {
        const r = await request(method, path, body, this.h);
        this.step('api', { method, path, status: r.status, code: r.body && r.body.code, error: r.body && r.body.error });
        return r;
    }

    async load() { const r = await this.api('GET', `/api/playbooks/${this.pb.id}`); if (r.status !== 200) throw new Error(`GET playbook ${r.status}`); this.pb = r.body.playbook; return this.pb; }

    async patch(body) {
        const r = await this.api('PATCH', `/api/playbooks/${this.pb.id}`, { expectedVersion: this.pb.version, ...body });
        if (r.status === 409 && r.body && r.body.code === 'version_conflict') { this.pb = r.body.playbook; this.note(`version conflict — reloaded to v${this.pb.version}, retrying once`); return this.patch(body); }
        if (r.status !== 200 || !r.body.playbook) { const e = new Error(`PATCH ${JSON.stringify(body).slice(0, 120)} → ${r.status} ${r.body && (r.body.code || r.body.error)}`); e.response = r; throw e; }
        this.pb = r.body.playbook; return r;
    }

    async resolveDatatable(name) {
        const r = await this.api('GET', '/api/datatables');
        const list = (r.body && (r.body.datatables || r.body)) || [];
        const hits = list.filter((t) => t.name === name);
        if (!hits.length) throw new Error(`no datatable named "${name}" visible to the harness user`);
        const pick = this.c.options.datatableManagedKind ? hits.find((t) => t.managedKind === this.c.options.datatableManagedKind) || hits[0] : hits[0];
        this.note(`existing table "${name}" → ${pick.id} (${pick.managedKind || 'own'}, ${pick.rowCount} rows)`);
        return pick.id;
    }

    /** A case may need a table to exist first (the "wrong columns" case). */
    async setupTable(spec) {
        const list = await this.api('GET', '/api/datatables');
        const rows = (list.body && (list.body.datatables || list.body)) || [];
        if (rows.some((t) => t.name === spec.name)) { this.note(`setup table "${spec.name}" exists`); return; }
        const r = await this.api('POST', '/api/datatables', { name: spec.name, key: spec.key, description: spec.description || 'Playbook harness fixture', fields: spec.fields });
        if (r.status !== 201 && r.status !== 200) throw new Error(`setup table → ${r.status} ${r.body && (r.body.code || r.body.error)}`);
        this.note(`setup table "${spec.name}" created`);
    }

    /** API-only: every document must be refused with the expected validator codes. */
    async runDocuments() {
        this.report.documents = [];
        for (const d of this.c.documents) {
            const recipe = JSON.parse(JSON.stringify(d.recipe));
            if (d.briefLength) for (const p of recipe.phases) if (p.brief) p.brief = 'x'.repeat(d.briefLength);
            const r = await this.api('POST', '/api/playbooks', { recipe, title: 'PB invalid', options: {} });
            const codes = (r.body && Array.isArray(r.body.errors)) ? r.body.errors.map((e) => e.code) : [];
            const ok = r.status === 400 && r.body && r.body.code === 'recipe_invalid' && (d.expectCodes || []).every((c) => codes.includes(c));
            this.report.documents.push({ name: d.name, status: r.status, code: r.body && r.body.code, codes, ok });
            this.note(`${ok ? 'ok ' : 'BAD'} ${d.name}: ${r.status} ${r.body && r.body.code} [${codes.join(',')}]`);
            if (r.status === 201 && r.body.playbook) await this.api('DELETE', `/api/playbooks/${r.body.playbook.id}`);
        }
        this.report.finalStatus = this.report.documents.every((d) => d.ok) ? 'done' : 'mismatch';
        this.report.phases = [];
    }

    async create() {
        let recipeBody = {};
        if (this.c.describe) {
            const t0 = Date.now();
            const r = await this.api('POST', '/api/playbooks/recipes/compose', { description: this.c.describe, locale: this.c.locale || 'nl' });
            this.report.compose = { status: r.status, ms: Date.now() - t0, body: r.body };
            if (r.status !== 200) { this.note(`compose refused: ${r.status} ${r.body && r.body.code} ${JSON.stringify(r.body && r.body.errors)}`); return { composeRefused: r }; }
            this.note(`composed "${r.body.recipe.title}": ${r.body.recipe.phases.map((p) => `${p.key}:${p.kind}`).join(' → ')}; columns ${(r.body.recipe.table ? r.body.recipe.table.fields.map((f) => f.key) : []).join(',') || '—'}; inputs ${r.body.recipe.inputs.map((i) => i.key).join(',') || '—'}`);
            recipeBody = { recipe: r.body.recipe };
        } else if (this.c.recipe) {
            recipeBody = { recipe: this.c.recipe };
        } else {
            recipeBody = { recipeId: this.c.recipeId || 'invoice_tracker' };
        }
        const o = { ...(this.c.options || {}) };
        if (o.datatableName) { o.datatableId = await this.resolveDatatable(o.datatableName); o.tableMode = 'existing'; delete o.datatableName; delete o.datatableManagedKind; }
        const r = await this.api('POST', '/api/playbooks', { ...recipeBody, title: this.c.title, options: o });
        if (r.status !== 201) { const e = new Error(`create → ${r.status} ${r.body && (r.body.code || r.body.error)} ${JSON.stringify(r.body && r.body.errors)}`); e.response = r; throw e; }
        this.pb = r.body.playbook;
        this.report.playbookId = this.pb.id;
        this.note(`playbook ${this.pb.id}: ${this.pb.phases.map((p) => `${p.key}(${kindOf(p)})`).join(' → ')}`);
        return { created: true };
    }

    async runServerPhase(phase) {
        const t0 = Date.now();
        const r = await this.api('POST', `/api/playbooks/${this.pb.id}/phases/${phase.key}/run`);
        if (r.body && r.body.playbook) this.pb = r.body.playbook;
        if (r.status !== 200 && r.status !== 202) { this.note(`${phase.key} run → ${r.status} ${r.body && r.body.code}: ${r.body && r.body.error}${r.body && r.body.missing ? ` missing=${r.body.missing.join(',')}` : ''}`); return; }
        while (phaseByKey(this.pb.phases, phase.key).status === 'running') {
            if (Date.now() - t0 > SERVER_PHASE_TIMEOUT_MS) throw new Error(`${phase.key} still running after ${SERVER_PHASE_TIMEOUT_MS} ms`);
            await sleep(POLL_MS);
            await this.load();
        }
        const p = phaseByKey(this.pb.phases, phase.key);
        this.note(`${phase.key} → ${p.status} in ${Math.round((Date.now() - t0) / 1000)}s${p.summary ? ` — ${p.summary}` : ''}${p.error ? ` — error: ${p.error}` : ''}`);
    }

    async runBuilderPhase(phase) {
        const kind = kindOf(phase);
        await this.patch({ phases: [{ key: phase.key, status: 'running' }] });
        if (this.c.scenario === 'stop_resume_automation' && kind === 'automation' && !this.scenarioDone) {
            this.scenarioDone = true;
            this.note('scenario: stop while the automation phase runs, then resume');
            await this.patch({ status: 'stopped' });
            if (this.pb.status !== 'stopped') throw new Error('stop did not take');
            await this.patch({ status: 'active' });
            const p = phaseByKey(this.pb.phases, phase.key);
            this.note(`after resume: ${phase.key} is ${p.status} (${p.error})`);
            return; // the loop sees failed → retry policy
        }
        const cur = phaseByKey(this.pb.phases, phase.key);
        const brief = cur.brief;
        if (!brief) throw new Error(`${phase.key} has no brief`);
        const tier = (this.pb.options && this.pb.options.tier) || 'fast';
        let round = 0; const calls = [];
        const onEvent = (ev, data) => {
            if (ev === 'round_start') round += 1;
            if (ev === 'tool_call') {
                // The two streams shape a refusal differently: the automation
                // builder puts it in result.error, the app builder in ok:false.
                const r = data && data.result;
                const failed = !!((r && typeof r === 'object' && r.error) || (data && data.ok === false));
                const repeat = (r && typeof r === 'object' && r._repeated) || (/"_repeated":(\d+)/.exec(String(r || '')) || [])[1] || 1;
                const err = failed ? String((r && typeof r === 'object' && r.error) || data.error || data.summary || '').replace(/\s+/g, ' ').slice(0, 140) : '';
                const line = `r${round} ${data.name || data.tool} ${failed ? 'ERR' : 'ok'}${Number(repeat) > 1 ? ` repeat=${repeat}` : ''}${err ? ` ${err}` : ''}`;
                calls.push(line); if (this.printCalls) console.log('    ' + line);
            }
        };
        let res;
        try {
            if (kind === 'automation') {
                const body = { message: brief, modelTier: tier, timezone: 'Europe/Amsterdam', history: [], ...(cur.artifacts && cur.artifacts.automationId ? { automationId: cur.artifacts.automationId } : {}) };
                res = await stream('/api/automation/builder/stream', body, this.h, onEvent);
            } else {
                const appId = cur.artifacts && cur.artifacts.appId;
                if (!appId) throw new Error(`${phase.key} has no appId`);
                res = await stream('/api/studio-apps/builder/stream', { message: brief, appId, modelTier: tier, planMode: 'never' }, this.h, onEvent);
            }
        } catch (e) {
            this.report.errors.push(`${phase.key}: ${e.message}`);
            this.note(`${phase.key} stream error: ${e.message}`);
            await this.patch({ phases: [{ key: phase.key, status: 'failed', error: `stream: ${e.message}`.slice(0, 300) }] });
            return;
        }
        const events = res.events;
        const done = [...events].reverse().find((e) => e.event === 'done');
        const errs = events.filter((e) => e.event === 'error');
        const aborted = events.find((e) => e.event === 'builder_aborted');
        const lastDraft = [...events].reverse().find((e) => e.event === 'draft');
        const finalized = !!(done && done.data && done.data.finalized);
        const automationId = (done && done.data && done.data.automationId) || (events.find((e) => e.event === 'builder_session' && e.data && e.data.automationId) || {}).data?.automationId || (cur.artifacts && cur.artifacts.automationId) || null;
        const failedCalls = calls.filter((l) => l.includes(' ERR')).length;
        this.report.streams.push({ phase: phase.key, kind, attempt: cur.attempt || 0, ms: res.ms, rounds: round, calls: calls.length, failedCalls, finalized, aborted: !!aborted, errors: errs.map((e) => e.data && (e.data.error || e.data.code)), callLines: calls, definition: lastDraft ? lastDraft.data.definition : null, events });
        this.note(`${phase.key} stream: ${Math.round(res.ms / 1000)}s, ${round} rounds, ${calls.length} calls (${failedCalls} refused), finalized=${finalized}${aborted ? ' ABORTED' : ''}${errs.length ? ` errors=${errs.length}` : ''}`);
        if (finalized) {
            const artifacts = kind === 'automation' ? { automationId } : { appId: cur.artifacts.appId };
            try {
                await this.patch({ phases: [{ key: phase.key, status: 'awaiting', artifacts, summary: `${kind} finalized by the harness` }] });
            } catch (e) {
                this.note(`awaiting refused: ${e.message}`);
                await this.patch({ phases: [{ key: phase.key, status: 'failed', error: `awaiting refused: ${e.message}`.slice(0, 300) }] });
            }
        } else {
            const why = aborted ? `aborted: ${aborted.data && aborted.data.reason}` : (errs.length ? `error: ${JSON.stringify(errs[0].data).slice(0, 200)}` : 'turn ended without finalize (the builder asked a question or stopped)');
            if (kind === 'automation' && automationId) await this.patch({ phases: [{ key: phase.key, artifacts: { automationId } }] });
            await this.patch({ phases: [{ key: phase.key, status: 'failed', error: why.slice(0, 300) }] });
        }
    }

    async handleFailed(phase) {
        const policy = (this.c.onFail && this.c.onFail[phase.key]) || (this.c.onFail && this.c.onFail['*']) || (kindOf(phase) === 'table' ? 'stop' : 'retry_once');
        const attempts = (this.retried = this.retried || {});
        if (policy === 'retry_once' && !attempts[phase.key]) {
            attempts[phase.key] = 1;
            this.note(`${phase.key} failed (${phase.error}) → retry`);
            const r = await this.api('POST', `/api/playbooks/${this.pb.id}/phases/${phase.key}/retry`, { expectedVersion: this.pb.version });
            if (r.body && r.body.playbook) this.pb = r.body.playbook; else throw new Error(`retry → ${r.status} ${r.body && r.body.code}`);
            return;
        }
        if (policy === 'skip' || policy === 'retry_once') {
            this.note(`${phase.key} failed (${phase.error}) → skip`);
            const r = await this.api('POST', `/api/playbooks/${this.pb.id}/phases/${phase.key}/skip`, { expectedVersion: this.pb.version });
            if (r.body && r.body.playbook) this.pb = r.body.playbook; else throw new Error(`skip → ${r.status} ${r.body && r.body.code}`);
            return;
        }
        this.note(`${phase.key} failed (${phase.error}) → stop`);
        await this.patch({ status: 'stopped' });
    }

    async run() {
        if (this.c.apiOnly) return this.runDocuments();
        if (this.c.setupTable) await this.setupTable(this.c.setupTable);
        const created = await this.create();
        if (created.composeRefused) return;
        const skip = new Set(this.c.skip || []);
        let guard = 0;
        while (this.pb.status === 'active' && guard++ < 60) {
            const phase = nextActionable(this.pb.phases);
            if (!phase) { await this.load(); if (!nextActionable(this.pb.phases)) break; continue; }
            const kind = kindOf(phase);
            if (phase.status === 'ready' && skip.has(phase.key)) {
                this.note(`${phase.key}: skipped by the case`);
                const r = await this.api('POST', `/api/playbooks/${this.pb.id}/phases/${phase.key}/skip`, { expectedVersion: this.pb.version });
                if (r.body && r.body.playbook) this.pb = r.body.playbook; else throw new Error(`skip → ${r.status}`);
                continue;
            }
            if (phase.status === 'ready') {
                if (kind === 'table' || kind === 'fill' || kind === 'design') await this.runServerPhase(phase);
                else await this.runBuilderPhase(phase);
                continue;
            }
            if (phase.status === 'running') {
                // A server phase still running (202) — poll; a builder phase running here means a crash mid-stream.
                if (kind === 'table' || kind === 'fill' || kind === 'design') { await sleep(POLL_MS); await this.load(); continue; }
                throw new Error(`${phase.key} is running without a stream — the harness lost it`);
            }
            if (phase.status === 'awaiting') {
                // `until` matches the phase KEY or its KIND: a composed
                // playbook carries whatever key the model wrote for its table
                // phase (`table`, `create_table`, …), and a case that only
                // wants the cheap table gate must not run the live builders
                // for minutes because of that spelling.
                if (this.c.until && (phase.key === this.c.until || kindOf(phase) === this.c.until)) { this.note(`until ${phase.key} (${kindOf(phase)}): stopping here`); break; }
                const before = this.pb.version;
                await this.patch({ phases: [{ key: phase.key, status: 'done' }] });
                const next = nextActionable(this.pb.phases);
                this.note(`${phase.key} done (v${before}→v${this.pb.version}); next ${next ? `${next.key} ${next.status}` : '—'}; playbook ${this.pb.status}`);
                continue;
            }
            if (phase.status === 'failed') { await this.handleFailed(phase); continue; }
        }
        this.report.finalStatus = this.pb.status;
        this.report.phases = this.pb.phases.map((p) => ({ key: p.key, kind: kindOf(p), status: p.status, attempt: p.attempt, error: p.error, summary: p.summary, artifacts: p.artifacts }));
    }
}

// ── Judge ───────────────────────────────────────────────────────────────────

function judge(h, expect, drivers) {
    const failures = [];
    const r = h.report;
    if (!expect) return failures;
    if (expect.compose) {
        const c = r.compose;
        if (!c || c.status !== 200) failures.push(`compose: expected 200, got ${c ? `${c.status} ${c.body && c.body.code}` : 'no call'}`);
        else if (expect.compose.kinds) {
            const kinds = c.body.recipe.phases.map((p) => p.kind);
            if (JSON.stringify(kinds) !== JSON.stringify(expect.compose.kinds)) failures.push(`compose kinds: expected ${expect.compose.kinds.join(',')}, got ${kinds.join(',')}`);
        }
        if (expect.compose.minColumns && !(c && c.body.recipe.table && c.body.recipe.table.fields.length >= expect.compose.minColumns)) failures.push(`compose: expected ≥ ${expect.compose.minColumns} columns`);
    }
    if (expect.composeRefused) {
        const c = r.compose;
        if (!c || c.status === 200) failures.push(`compose: expected a refusal, got ${c ? c.status : 'no call'}`);
        else if (c.status >= 500 && c.status !== 502) failures.push(`compose: a ${c.status}`);
    }
    if (expect.status && r.finalStatus !== expect.status) failures.push(`playbook status: expected ${expect.status}, got ${r.finalStatus}`);
    if (r.documents) for (const d of r.documents) if (!d.ok) failures.push(`document "${d.name}": ${d.status} ${d.code} [${d.codes.join(',')}]`);
    if (expect.phases && r.phases) {
        for (const [key, want] of Object.entries(expect.phases)) {
            // A custom recipe names its phases itself: match by key, else by kind.
            const p = r.phases.find((x) => x.key === key) || r.phases.find((x) => x.kind === key);
            const ok = Array.isArray(want) ? want : [want];
            if (!p) failures.push(`phase ${key}: missing`);
            else if (!ok.includes(p.status)) failures.push(`phase ${key}: expected ${ok.join('|')}, got ${p.status}${p.error ? ` (${p.error})` : ''}`);
        }
    }
    if (Number.isFinite(expect.minRows)) {
        const fill = (r.phases || []).find((p) => p.kind === 'fill');
        const rows = fill && fill.artifacts ? fill.artifacts.rowCount : null;
        if (!(Number.isFinite(rows) && rows >= expect.minRows)) failures.push(`rows: expected ≥ ${expect.minRows}, got ${rows}`);
    }
    if (Number.isFinite(expect.maxAttempts)) {
        for (const p of r.phases || []) if ((p.attempt || 0) > expect.maxAttempts) failures.push(`phase ${p.key}: ${p.attempt} attempts > ${expect.maxAttempts}`);
    }
    // The last stream with a definition for a phase: `automation` is the FEEDING
    // automation (not the approval one), `approvals` is the phase of that key —
    // an automation since 2026-09-14 (Studio → Approvals), an app_turn before.
    const lastStream = (pred) => [...r.streams].reverse().find((s) => s.definition && pred(s));
    const judgeWith = (label, s, exp) => {
        const driver = s.kind === 'automation' ? drivers.automation : drivers.app;
        if (!driver) return;
        const v = driver.matchExpectation(s.definition, s.events, exp);
        for (const f of v.failures) failures.push(`${label}: ${f}`);
    };
    if (expect.automation) {
        const s = lastStream((x) => x.kind === 'automation' && x.phase !== 'approvals') || lastStream((x) => x.kind === 'automation');
        if (!s) failures.push('automation: no stream with a definition');
        else judgeWith('automation', s, expect.automation);
    }
    if (expect.app) {
        const s = lastStream((x) => x.kind === 'app');
        if (!s) failures.push('app: no stream with a definition');
        else judgeWith('app', s, expect.app);
    }
    if (expect.approvals) {
        const s = lastStream((x) => x.phase === 'approvals') || lastStream((x) => x.kind === 'app_turn');
        if (!s) failures.push('approvals: no stream with a definition');
        else judgeWith('approvals', s, expect.approvals);
    }
    return failures;
}

async function main() {
    const casePath = arg('case', null);
    if (!casePath) { console.error('need --case <file>'); return EXIT.HARNESS; }
    const caseFile = JSON.parse(fs.readFileSync(casePath, 'utf8'));
    const outPath = arg('out', '/tmp/playbook-run.json');
    const jwt = require(APP + '/node_modules/jsonwebtoken');
    const key = await require(APP + '/stores/configStore').getSecret(`connector_tenant_key_${ORG}`);
    if (!key) { console.error(`no tenant key for org ${ORG}`); return EXIT.HARNESS; }
    const token = jwt.sign({ sub: NC_UID, email: EMAIL, name: NC_UID, nc_admin: true }, key, { algorithm: 'HS256', issuer: 'nextcloud-connector', audience: 'beeflow.nl', expiresIn: 4 * 3600 });
    const headers = { Authorization: `Bearer ${token}`, 'X-Beeflow-Source': 'nextcloud-connector', 'X-Beeflow-NC-Uid': NC_UID, 'Content-Type': 'application/json' };
    const drivers = {};
    try { drivers.automation = require('/tmp/drive-builder.js'); } catch { /* judged without the automation matcher */ }
    try { drivers.app = require('/tmp/drive-app-builder.js'); } catch { /* judged without the app matcher */ }

    console.log(`\n=== ${caseFile.id}: ${caseFile.title} ===`);
    const h = new Harness(headers, caseFile, flag('print-calls'));
    const t0 = Date.now();
    let exit = EXIT.PASS;
    try {
        await h.run();
    } catch (e) {
        h.report.errors.push(`run: ${e.message}`);
        console.error(`  run error: ${e.message}`);
        exit = EXIT.STREAM;
    }
    h.report.ms = Date.now() - t0;
    const failures = judge(h, caseFile.expect, drivers);
    h.report.verdict = { failures, ok: failures.length === 0 && exit === EXIT.PASS };
    fs.writeFileSync(outPath, JSON.stringify(h.report, null, 1));
    console.log(`\n  phases: ${(h.report.phases || []).map((p) => `${p.key}=${p.status}${p.attempt ? `(a${p.attempt})` : ''}`).join(' ')}`);
    console.log(`  streams: ${h.report.streams.map((s) => `${s.phase}:${Math.round(s.ms / 1000)}s/${s.rounds}r/${s.calls}c/${s.failedCalls}x${s.finalized ? '' : '/NOT-FINALIZED'}`).join(' ')}`);
    console.log(`  total ${Math.round(h.report.ms / 1000)}s · playbook ${h.report.playbookId || '—'} · status ${h.report.finalStatus || '—'}`);
    if (failures.length) { console.log(`\n  MISMATCH (${failures.length}):`); for (const f of failures) console.log(`   - ${f}`); if (exit === EXIT.PASS) exit = EXIT.MISMATCH; }
    else if (exit === EXIT.PASS) console.log('\n  PASS');
    console.log(`  (report: ${outPath})`);
    return exit;
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((e) => { console.error(e); process.exit(EXIT.HARNESS); });
}

module.exports = { judge, nextActionable, kindOf, EXIT };

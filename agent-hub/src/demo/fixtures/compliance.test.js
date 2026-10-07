import { describe, it, expect } from 'vitest';
import { createState, ROUTES } from './compliance';
import { CHECK_DEFS, ISO_CONTROLS, FRAMEWORKS, MILESTONES } from './complianceCatalog';
import { COMMON_ROUTES, DEMO_CAPABILITIES } from './common';
import { DEMO_FEATURES } from '../registry';
import { createDemoTransport } from '../demoTransport';

/**
 * What these pin is the class of bug that does not throw.
 *
 * Writing this fixture, three of the six check ids I referenced by hand were
 * wrong — `ISO27001-A.8.8-vulnerability-management` instead of
 * `ISO27001-A.8.8-vuln-mgmt`, and two more like it. Nothing failed. The
 * override simply did not match, the check fell through to "pass", and the
 * demo rendered a flawless 100/100 compliance score with no failing items —
 * the single least believable thing a compliance demo could show, and it
 * would have shipped looking deliberate.
 *
 * So: every id must resolve, and the arithmetic must agree with itself.
 */

const ctx = (over = {}) => ({ state: createState(), query: new URLSearchParams(), params: {}, body: {}, ...over });
const call = (route, over) => ROUTES[route](ctx(over));

const CHECK_IDS = new Set(CHECK_DEFS.map(d => d.check_id));

describe('compliance fixture — catalog agreement', () => {
    it('every check row is a real check definition', () => {
        for (const row of call('GET /api/compliance/checks')) {
            expect(CHECK_IDS.has(row.check_id), `${row.check_id} is not in the registry`).toBe(true);
            expect(row.titleKey, `${row.check_id} needs a titleKey`).toBeTruthy();
            expect(['pass', 'warn', 'fail', 'not_applicable']).toContain(row.status);
        }
    });

    it('the demo is not a clean sheet — it shows real failures', () => {
        // A 100/100 score is what a fixture with mistyped check ids produces,
        // and it is also the least persuasive thing this page could claim.
        const rows = call('GET /api/compliance/checks');
        expect(rows.filter(r => r.status === 'fail').length).toBeGreaterThan(0);
        expect(rows.filter(r => r.status === 'warn').length).toBeGreaterThan(0);
        const overall = call('GET /api/compliance/overview').overall;
        expect(overall.score).toBeGreaterThan(60);
        expect(overall.score).toBeLessThan(100);
    });

    it('every failing or warning check explains itself', () => {
        // A red row with an empty "details" column tells a visitor nothing,
        // and the real product always writes one.
        for (const r of call('GET /api/compliance/checks')) {
            if (r.status === 'fail' || r.status === 'warn') {
                expect(r.details, `${r.check_id} is ${r.status} with no details`).toBeTruthy();
            }
        }
    });

    it('the SoA covers the real Annex A catalog and cross-references real checks', () => {
        const soa = call('GET /api/compliance/iso/soa');
        expect(soa.controls.length).toBe(ISO_CONTROLS.length);
        for (const c of soa.controls) {
            for (const id of c.checks) {
                expect(CHECK_IDS.has(id), `${c.ref} points at unknown check ${id}`).toBe(true);
            }
        }
        // At least one control must actually be evidenced by a check, or the
        // SoA's "how is this verified" column is empty for all 93 rows.
        expect(soa.controls.filter(c => c.checks.length > 0).length).toBeGreaterThan(5);
    });
});

describe('compliance fixture — arithmetic that is visible on screen', () => {
    it('the headline score is the score of the checks below it', () => {
        const o = call('GET /api/compliance/overview');
        const rows = call('GET /api/compliance/checks');
        const W = { critical: 3, high: 2, medium: 1, low: 0.5 };
        let earned = 0, max = 0;
        for (const r of rows) {
            if (r.status === 'not_applicable') continue;
            const w = W[r.severity] || 1;
            max += w;
            if (r.status === 'pass') earned += w;
            else if (r.status === 'warn') earned += w * 0.5;
        }
        expect(o.overall.score).toBe(Math.round((earned / max) * 100));
        expect(o.overall.pass + o.overall.warn + o.overall.fail + o.overall.na).toBe(rows.length);
        expect(o.total_checks).toBe(rows.length);
    });

    it('the trend line ends where the headline score is', () => {
        // A chart whose last point disagrees with the number beside it is the
        // first thing anyone notices.
        const o = call('GET /api/compliance/overview');
        const history = call('GET /api/compliance/score-history');
        expect(history.length).toBeGreaterThan(5);
        expect(history[history.length - 1].overall_score).toBe(o.overall.score);
        const values = history.map(h => h.overall_score);
        expect(Math.max(...values)).toBeGreaterThan(Math.min(...values));
    });

    it('the SoA stats add up to the control count', () => {
        const { stats, controls } = call('GET /api/compliance/iso/soa');
        expect(stats.approved + stats.reviewed + stats.excluded + stats.todo).toBe(stats.total);
        expect(stats.total).toBe(controls.length);
        // A row with a decision must carry the entry the table reads; a row
        // without one must be null, not an empty object.
        for (const c of controls) {
            if (c.entry) expect(c.entry.status).toBeTruthy();
        }
    });

    it('every excluded control carries a justification', () => {
        // An exclusion without a reason is the one thing an ISO auditor will
        // always pick up, so the demo must not model it.
        for (const c of call('GET /api/compliance/iso/soa').controls) {
            if (c.entry?.status === 'excluded') {
                expect(c.entry.justification?.length, `${c.ref} excluded with no justification`).toBeGreaterThan(20);
            }
        }
    });

    it('readiness nests its counters under `controls`, where the page reads them', () => {
        // IsoOverviewPage does `readiness?.controls || {}`. A flat
        // `{ verified: 41 }` renders every tile as 0 without an error.
        const r = call('GET /api/compliance/iso/readiness');
        for (const k of ['verifiable_total', 'verified', 'failing', 'unchecked', 'catalog_total']) {
            expect(r.controls[k], `readiness.controls.${k}`).toBeTypeOf('number');
        }
        expect(r.controls.verified + r.controls.failing + r.controls.unchecked)
            .toBeLessThanOrEqual(r.controls.verifiable_total);
        expect(r.controls.catalog_total).toBe(ISO_CONTROLS.length);
        expect(r.soa.total).toBeGreaterThan(0);
        expect(r.history_points.length).toBeGreaterThan(0);
    });

    it('risk scores are likelihood × impact, and the stats match the rows', () => {
        const { risks, stats } = call('GET /api/compliance/iso/risks');
        for (const r of risks) expect(r.score).toBe(r.likelihood * r.impact);
        expect(stats.total).toBe(risks.length);
        // riskStore.getStats counts each status on its own: "open" is status open, not open or treating.
        expect(stats.open).toBe(risks.filter(r => r.status === 'open').length);
        expect(stats.treating).toBe(risks.filter(r => r.status === 'treating').length);
        // The server's rule (riskStore HIGH_SCORE = 10), so header, rail and the "High" filter agree.
        expect(stats.high).toBe(risks.filter(r => r.score >= 10 && r.status !== 'closed').length);
    });
});

describe('compliance fixture — the states the pages need to render', () => {
    it('the org is onboarded, or the wizard covers the whole demo', () => {
        // ComplianceHub: `if (!o?.onboarded) setShowWizard(true)`. A visitor
        // would land on a four-step setup form instead of the hub.
        expect(call('GET /api/compliance/overview').onboarded).toBe(true);
    });

    it('deadline_at is the earliest clock still open, and empty once the incident is closed', () => {
        // incidentStore.nextOpenDeadline. A GDPR breach runs on the 72-hour
        // notification; the DORA incident's customer notice (4 h) comes first.
        const H = 3_600_000;
        const delta = (i) => new Date(i.deadline_at).getTime() - new Date(i.detected_at).getTime();
        for (const i of call('GET /api/compliance/incidents')) {
            if (i.status === 'closed') expect(i.deadline_at, `${i.id}`).toBeNull();
            else if (i.regimes.includes('DORA')) expect(delta(i), `${i.id}`).toBe(4 * H);
            else expect(delta(i), `${i.id}`).toBe(72 * H);
        }
    });

    it('the register shows a breach inside its window and one already notified', () => {
        const list = call('GET /api/compliance/incidents');
        expect(list.some(i => i.status !== 'closed' && new Date(i.deadline_at).getTime() > Date.now())).toBe(true);
        expect(list.some(i => i.authority_notified_at && i.authority_reference)).toBe(true);
    });

    it('the DSR inbox covers every status the page renders a pill for', () => {
        const statuses = new Set(call('GET /api/dsr/requests').map(r => r.status));
        for (const s of ['pending', 'in_progress', 'fulfilled', 'rejected']) {
            expect(statuses.has(s), `no DSR with status ${s}`).toBe(true);
        }
        // A resolved request with no summary is a row that says nothing.
        for (const r of call('GET /api/dsr/requests')) {
            if (r.status === 'fulfilled' || r.status === 'rejected') {
                expect(r.result_summary, `${r.id} resolved with no summary`).toBeTruthy();
            }
        }
    });

    it('the ROPA names its processors and flags the transfers out of the EEA', () => {
        const ropa = call('GET /api/compliance/ropa');
        expect(ropa.controller.name).toBeTruthy();
        expect(ropa.processors.length).toBeGreaterThan(2);
        const nonEu = ropa.processors.filter(p => p.is_eu === false);
        expect(nonEu.length, 'a ROPA with no third-country transfer proves nothing').toBeGreaterThan(0);
        for (const p of ropa.processors) {
            expect(typeof p.is_eu, `${p.operator}.is_eu must be a strict boolean`).toBe('boolean');
        }
        // Each assistant lists those same transfers, or the column is blank;
        // a project's record keeps its data with the project's members.
        for (const a of ropa.activities.filter(x => x.source?.kind !== 'project')) {
            expect(a.transfers.length).toBe(nonEu.length);
        }
        expect(ropa.activities.some(a => a.source?.kind === 'project')).toBe(true);
    });

    it('personnel cannot have acknowledged more policies than exist', () => {
        for (const p of call('GET /api/compliance/iso/training').personnel) {
            expect(p.policy_acks).toBeLessThanOrEqual(p.policy_total);
            expect(p.displayName).toBeTruthy();
        }
    });

    it('the licence capability the hub is gated on is granted', () => {
        expect(DEMO_CAPABILITIES).toContain('compliance_hub_gdpr');
    });
});

describe('compliance fixture — the route table itself', () => {
    it('every key is a method and an /api path the transport can compile', () => {
        // demoTransport splits on the FIRST space and compiles the rest as a
        // pattern. A typo ('GET/api/…', a double space, a lower-case verb)
        // registers a route that can never match, and the screen behind it
        // shows "no fixture" in the console and an empty panel on screen.
        const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
        for (const key of Object.keys(ROUTES)) {
            const [method, path, extra] = key.split(' ');
            expect(METHODS, `${key}: unknown method`).toContain(method);
            expect(extra, `${key}: more than one space`).toBeUndefined();
            expect(path, `${key}: not an api path`).toMatch(/^\/(api|agents|auth)\//);
            expect(typeof ROUTES[key], `${key}: handler`).toBe('function');
        }
    });

    it('declares the literal evidence and custom routes before their :param twins', () => {
        // First match wins. `/evidence/chain` under `/evidence/:checkId` would
        // verify a chain for a check called "chain"; the server's router
        // carries the same warning.
        const keys = Object.keys(ROUTES);
        const before = (a, b) => expect(keys.indexOf(a), `${a} must precede ${b}`).toBeLessThan(keys.indexOf(b));
        before('GET /api/compliance/evidence/chain', 'GET /api/compliance/evidence/:checkId');
        before('GET /api/compliance/custom/frameworks/:id/export.json', 'GET /api/compliance/custom/frameworks/:id');
        before('GET /api/dsr/requests/:id/timeline', 'GET /api/dsr/requests/:id');
        before('GET /api/dsr/requests/:id/discovery', 'GET /api/dsr/requests/:id');
    });
});

describe('compliance fixture — the aggregates the shell reads', () => {
    it('the attention list opens on the check the demo registry pins', () => {
        // demo/registry.js waits for `expectText` before calling the demo
        // loaded. It is a check TITLE, and after the redesign that title also
        // has to survive the attention ranking — fail first, then severity,
        // then most recently run.
        const a = call('GET /api/compliance/attention');
        expect(a.items[0].title).toBe('AI disclosure to users');
        expect(a.items[0].status).toBe('fail');
        expect(DEMO_FEATURES.compliance.expectText).toBe('AI disclosure to users');
    });

    it('every attention row can be acted on, and none of them names a person', () => {
        const a = call('GET /api/compliance/attention', { query: new URLSearchParams('limit=50') });
        expect(a.total).toBe(a.items.length);
        expect(a.complete).toBe(true);
        for (const i of a.items) {
            expect(['check', 'register']).toContain(i.source);
            expect(['auto_fix', 'open_fix', 'navigate']).toContain(i.action.type);
            expect(i.action.label_key, `${i.id} needs a label key`).toMatch(/^compliance\./);
            if (i.action.type !== 'auto_fix') expect(i.action.target, `${i.id} needs a target`).toBeTruthy();
            // BFSF-441: an e-mail address must never reach this card.
            const text = `${i.title} ${i.meta.detail || ''}`;
            expect(text, `${i.id} leaks an address`).not.toMatch(/[\w.]+@[\w.]+\.\w+/);
        }
    });

    it('the deadline clocks state their own urgency and where to go', () => {
        const d = call('GET /api/compliance/deadlines');
        expect(d.items.length).toBeGreaterThan(3);
        for (const i of d.items) {
            expect(['overdue', 'urgent', 'ok', 'none']).toContain(i.state);
            expect(i.pct).toBeGreaterThanOrEqual(0);
            expect(i.pct).toBeLessThanOrEqual(1);
            expect(i.target, `${i.id} has nowhere to go`).toBeTruthy();
            expect(i.meta.article, `${i.id} has no article`).toBeTruthy();
        }
        // An overdue row sorts above an open one, or the card is decoration.
        expect(d.items[0].state).toBe('overdue');
        // The CRA clocks have no rows: the register says so instead of
        // rendering an empty list.
        expect(d.empty_kinds).toContain('cra_early_warning');
    });

    it('the counts agree with the registers they sit next to', () => {
        const c = ctx();
        const counts = ROUTES['GET /api/compliance/counts'](c);
        const dsr = ROUTES['GET /api/dsr/requests'](c);
        expect(counts.dsr.open).toBe(dsr.filter(r => r.status === 'pending' || r.status === 'in_progress').length);
        expect(counts.soa.total).toBe(ROUTES['GET /api/compliance/iso/soa'](c).stats.total);
        expect(counts.risks.total).toBe(ROUTES['GET /api/compliance/iso/risks'](c).stats.total);
        expect(counts.evidence.rows).toBe(ROUTES['GET /api/compliance/evidence'](c).total);
        expect(counts.attention_open).toBe(ROUTES['GET /api/compliance/attention'](c).total);
        expect(counts.onboarded).toBe(true);
        // A framework that is off has no score key — the rail would draw a dot
        // for a framework this org never switched on.
        expect(Object.keys(counts.frameworks).sort()).toEqual(['aia', 'dora', 'gdpr', 'iso27001']);
    });

    it('`?keys=` returns only what was asked for, like the settings badge does', () => {
        const only = call('GET /api/compliance/counts', { query: new URLSearchParams('keys=attention_open') });
        expect(Object.keys(only)).toEqual(['attention_open']);
    });

    it('the calendar hides a framework the org called not relevant, `?all=1` shows it', () => {
        const shown = call('GET /api/compliance/calendar').milestones;
        const all = call('GET /api/compliance/calendar', { query: new URLSearchParams('all=1') }).milestones;
        expect(all.length).toBe(MILESTONES.length);
        expect(shown.some(m => m.framework_id === 'machinery')).toBe(false);
        expect(all.some(m => m.framework_id === 'machinery' && m.relevant === false)).toBe(true);
        for (const m of shown) expect(m.label_key).toMatch(/^compliance\.cal_ms_/);
    });
});

describe('compliance fixture — frameworks as a growing set', () => {
    it('lists the whole catalogue, with the three core ones on and no fake locks', () => {
        const { frameworks } = call('GET /api/compliance/frameworks');
        expect(frameworks.length).toBe(FRAMEWORKS.length);
        for (const f of frameworks) {
            expect(f.name_key).toMatch(/^compliance\.fw_/);
            expect(f.locked, `${f.id} must not be locked in a demo on an enterprise plan`).toBeNull();
            // A candidate has no score: it has no results to score.
            if (!f.enabled) expect(f.score, `${f.id} is off and still scored`).toBeNull();
        }
        for (const id of ['gdpr', 'aia', 'iso27001']) {
            const f = frameworks.find(x => x.id === id);
            expect(f.core).toBe(true);
            expect(f.enabled).toBe(true);
            expect(f.score).toBeGreaterThan(50);
        }
        // Two frameworks came into force inside the last 60 days — the whole
        // reason the page exists.
        expect(frameworks.filter(f => f.recently_in_force).length).toBeGreaterThan(0);
    });

    it('enabling a framework runs its checks; disabling a core one is refused', () => {
        const c = ctx();
        const before = ROUTES['GET /api/compliance/checks'](c).length;
        const r = ROUTES['POST /api/compliance/frameworks/:id/enable']({ ...c, params: { id: 'nis2' } });
        expect(r.framework.enabled).toBe(true);
        expect(r.framework.score).toBeTypeOf('number');
        const after = ROUTES['GET /api/compliance/checks'](c);
        expect(after.length).toBeGreaterThan(before);
        expect(after.some(x => x.framework_id === 'nis2')).toBe(true);
        // …and enabling it surfaces real work, not an instant 100.
        expect(after.some(x => x.framework_id === 'nis2' && x.status === 'fail')).toBe(true);
        expect(ROUTES['GET /api/compliance/counts'](c).frameworks.nis2.score).toBe(r.framework.score);

        const off = ROUTES['POST /api/compliance/frameworks/:id/disable']({ ...c, params: { id: 'nis2' } });
        expect(off.framework.enabled).toBe(false);
        expect(ROUTES['GET /api/compliance/checks'](c).length).toBe(before);

        const core = ROUTES['POST /api/compliance/frameworks/:id/disable']({ ...c, params: { id: 'gdpr' } });
        expect(core.status).toBe(400);
    });

    it('marking a framework not relevant keeps its dates out of the calendar', () => {
        const c = ctx();
        expect(ROUTES['GET /api/compliance/calendar'](c).milestones.some(m => m.framework_id === 'pld')).toBe(true);
        ROUTES['POST /api/compliance/frameworks/:id/relevance']({ ...c, params: { id: 'pld' }, body: { relevance: 'not_relevant' } });
        expect(ROUTES['GET /api/compliance/calendar'](c).milestones.some(m => m.framework_id === 'pld')).toBe(false);
    });
});

describe('compliance fixture — the DSR register after BE-2', () => {
    it('the list never carries a full address; the audited detail does', () => {
        const c = ctx();
        for (const r of ROUTES['GET /api/dsr/requests'](c)) {
            expect(r.subject_email_masked, `${r.id}`).toContain('•••');
            expect(r.subject_email, `${r.id} shows a full address in the list`).toBe(r.subject_email_masked);
            expect(r.timeline, `${r.id} ships its timeline to the list`).toBeUndefined();
        }
        const detail = ROUTES['GET /api/dsr/requests/:id']({ ...c, params: { id: '2417' } });
        expect(detail.subject_email).toBe('h.veenstra@example.nl');
        expect(detail.timeline.length).toBeGreaterThan(2);
        // …and reading it is logged, which is the point of showing it.
        expect(ROUTES['GET /api/compliance/access-audit'](c).entries[0].action).toBe('dsr.subject_viewed');
    });

    it('the clock is computed, and an open request is urgent before it is overdue', () => {
        const rows = call('GET /api/dsr/requests');
        const open = rows.filter(r => r.state !== 'none');
        expect(open.length).toBeGreaterThan(0);
        for (const r of rows) {
            const due = new Date(r.due_at).getTime() - new Date(r.created_at).getTime();
            expect(Math.round(due / 86_400_000), `${r.id}`).toBeGreaterThanOrEqual(30);
        }
        expect(rows.some(r => r.state === 'urgent')).toBe(true);
    });

    it('a deadline can be extended once, and the second attempt is refused', () => {
        const c = ctx({ params: { id: '2416' }, body: { reason: 'The claim file sits with two insurers.' } });
        const first = ROUTES['POST /api/dsr/requests/:id/extend'](c);
        expect(first.extension_reason).toBeTruthy();
        expect(new Date(first.due_at).getTime() - new Date(first.created_at).getTime()).toBe(90 * 86_400_000);
        const second = ROUTES['POST /api/dsr/requests/:id/extend'](c);
        expect(second.status).toBe(409);
    });

    it('recording a request by hand starts a clock and shows up in the register', () => {
        const c = ctx({ body: { subject_email: 'j.dorsman@example.nl', request_type: 'deletion', channel: 'phone' } });
        const created = ROUTES['POST /api/dsr/requests/manual'](c);
        expect(created.subject_email).toContain('•••');
        expect(created.state).toBe('ok');
        expect(created.identity_status).toBe('verified_manual');
        expect(ROUTES['GET /api/dsr/requests'](c)[0].id).toBe(created.id);
    });

    it('the discovery scan counts without naming, and says what it did not scan', () => {
        const d = call('GET /api/dsr/requests/:id/discovery', { params: { id: '2417' } });
        expect(d.subject.email_masked).toContain('•••');
        expect(d.not_scanned).toContain('conversations');
        expect(JSON.stringify(d)).not.toMatch(/[\w.]+@[\w.]+\.nl/);
        for (const s of d.sources) expect(s.label_key).toMatch(/^compliance\.dsr_discovery_/);
    });
});

describe('compliance fixture — the evidence ledger', () => {
    it('is one unbroken chain, newest first, and the footer counts the same rows', () => {
        const c = ctx();
        const { rows, total } = ROUTES['GET /api/compliance/evidence'](c);
        const chain = ROUTES['GET /api/compliance/evidence/chain'](c);
        expect(chain.ok).toBe(true);
        expect(chain.rows_total).toBe(total);
        expect(chain.head.seq).toBe(rows[0].seq);
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i].seq, 'the list runs newest first').toBe(rows[i - 1].seq - 1);
            // A sequence that disagrees with the timestamps is not a chain.
            expect(new Date(rows[i].captured_at).getTime()).toBeLessThanOrEqual(new Date(rows[i - 1].captured_at).getTime());
        }
        expect(rows.every(r => /^[0-9a-f]{64}$/.test(r.hash))).toBe(true);
    });

    it('filters by regulation the way the framework page asks for it', () => {
        const iso = call('GET /api/compliance/evidence', { query: new URLSearchParams('regulation=ISO27001&limit=5') });
        expect(iso.rows.length).toBe(5);
        expect(iso.total).toBeGreaterThan(5);
        for (const r of iso.rows) expect(r.check_id.startsWith('ISO27001-')).toBe(true);
    });

    it('the SoA change log is read out of that same ledger', () => {
        const history = call('GET /api/compliance/iso/soa/history');
        expect(history.length).toBeGreaterThan(10);
        const refs = new Set(ISO_CONTROLS.map(c => c.ref));
        for (const h of history) {
            expect(refs.has(h.control_ref), `${h.control_ref} is not an Annex A control`).toBe(true);
            expect(h.changed_at).toBeTruthy();
        }
    });
});

describe('compliance fixture — AI Act, own frameworks, portability', () => {
    it('the AI Act register carries one expired assessment, which is what makes the clock visible', () => {
        const list = call('GET /api/compliance/ai-act/assessments');
        expect(list.length).toBeGreaterThan(2);
        for (const a of list) {
            expect(['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal']).toContain(a.outcome);
        }
        expect(list.some(a => !a.current && new Date(a.expires_at) < new Date())).toBe(true);
    });

    it('an assessment detail carries live signals, and recording one stamps a 12-month clock', () => {
        const c = ctx({ params: { kind: 'agent', id: 'agent_helpdesk' } });
        const detail = ROUTES['GET /api/compliance/ai-act/assessments/:kind/:id'](c);
        expect(detail.signals.contains_ai).toBe(true);
        expect(detail.answers).toBeTruthy();
        const saved = ROUTES['PUT /api/compliance/ai-act/assessments/:kind/:id']({
            ...c,
            body: { answers: { art5: { answer: 'no', practices: [] }, art50: { interacts: 'yes' }, annex_iii: { answer: 'no', category: null } } },
        });
        expect(saved.outcome).toBe('transparency');
        expect(new Date(saved.expires_at).getTime()).toBeGreaterThan(Date.now());
        expect(ROUTES['GET /api/compliance/ai-act/assessments'](c)[0].target_id).toBe('agent_helpdesk');
    });

    it('a custom check is attested with evidence, and refused without it', () => {
        const c = ctx();
        const fw = ROUTES['GET /api/compliance/custom/frameworks/:id']({ ...c, params: { id: 'cfw_vvg' } });
        expect(fw.code).toBe('VVG');
        for (const check of fw.checks) expect(check.check_id).toBe(`CUSTOM-${fw.code}-${check.ref}`);
        const needsEvidence = fw.checks.find(x => x.evidence_required);
        expect(ROUTES['POST /api/compliance/custom/checks/:id/attest']({
            ...c, params: { id: needsEvidence.id }, body: { outcome: 'compliant' },
        }).status).toBe(400);
        const attested = ROUTES['POST /api/compliance/custom/checks/:id/attest']({
            ...c, params: { id: needsEvidence.id }, body: { outcome: 'compliant', statement: 'Recorded in the management review.', evidence_refs: ['MR 2026-07'] },
        });
        expect(attested.expires_at).toBeTruthy();
        expect(ROUTES['GET /api/compliance/custom/checks/:id/attestations']({ ...c, params: { id: needsEvidence.id } })[0].id).toBe(attested.id);
    });

    it('the export matrix names every kind and is honest about the gaps', () => {
        const rows = call('GET /api/compliance/portability');
        expect(rows.length).toBeGreaterThan(10);
        for (const r of rows) {
            expect(r.label_key).toMatch(/^compliance\.pf_kind_/);
            expect(r.mounted ? r.route : r.gap_key, `${r.kind} is neither exportable nor a declared gap`).toBeTruthy();
            if (r.mounted) expect(r.formats.length).toBeGreaterThan(0);
        }
        // A matrix with no gap would say this product exports everything.
        expect(rows.filter(r => !r.mounted).length).toBeGreaterThan(0);
        expect(call('GET /api/compliance/counts').portability.gaps).toBe(rows.filter(r => !r.mounted).length);
    });

    it('the machinery detector answers "scanned, nothing industrial" rather than nothing', () => {
        const d = call('GET /api/compliance/machinery/detections');
        expect(Object.keys(d.scanned).length).toBeGreaterThan(0);
        expect(d.matches).toEqual([]);
        expect(d.classifications).toContain('safety_component');
    });
});

describe('compliance fixture — every url the hub asks for is answered', () => {
    /**
     * The transport FAILS CLOSED: an unmatched url is a 404 with a console
     * warning, which on screen is an empty panel or a "could not be read"
     * line. So this walks the urls the hub's own data layer builds
     * (components/admin/compliance/data/*.js and the ladder's hook) through
     * the real matcher, with the real route table. A path typo — a missing
     * segment, a query string that swallows the match — shows up here rather
     * than in a visitor's console.
     */
    const URLS = [
        // data/useComplianceCore.js
        '/api/compliance/overview', '/api/compliance/checks', '/api/compliance/score-history',
        '/api/compliance/settings', '/api/compliance/org-users', '/api/compliance/checks?framework=dora',
        // data/useComplianceCounts.js + data/aggregates.js
        '/api/compliance/counts', '/api/compliance/counts?keys=attention_open',
        '/api/compliance/attention?limit=50', '/api/compliance/deadlines',
        '/api/compliance/frameworks', '/api/compliance/calendar', '/api/compliance/calendar?all=1',
        '/api/compliance/ai-act/assessments',
        '/api/compliance/ai-act/assessments/agent/agent_helpdesk',
        '/api/compliance/ai-act/assessments/agent/agent_helpdesk/signals',
        // pages/framework/EvidenceTab.jsx + the rail's chain footer
        '/api/compliance/evidence?regulation=GDPR&limit=25&offset=0',
        '/api/compliance/evidence/chain',
        '/api/compliance/evidence/GDPR-Art30-ropa-reviewed',
        // data/registers.js
        '/api/dsr/requests', '/api/dsr/requests/2417', '/api/dsr/requests/2417/timeline',
        '/api/dsr/requests/2417/discovery',
        '/api/compliance/ropa', '/api/compliance/ropa/projects', '/api/compliance/dpia', '/api/compliance/dpia/agent_intake',
        '/api/compliance/incidents', '/api/compliance/incidents?kind=vulnerability',
        '/api/compliance/iso/soa', '/api/compliance/iso/soa/history', '/api/compliance/iso/readiness',
        '/api/compliance/iso/docs', '/api/compliance/iso/connectors', '/api/compliance/iso/risks',
        '/api/compliance/iso/audit', '/api/compliance/iso/training',
        '/api/compliance/access-audit?offset=0', '/api/compliance/access-audit/actions',
        // the sections the redesign adds
        '/api/compliance/portability', '/api/compliance/machinery/detections',
        '/api/compliance/machinery/subjects/manual:1/attestations',
        '/api/compliance/custom/frameworks', '/api/compliance/custom/frameworks/cfw_vvg',
        '/api/compliance/custom/checks/cck_3_1/attestations',
        '/api/compliance/registry',
    ];

    it('answers every one of them with a body, not a 404', async () => {
        const fetchDemo = createDemoTransport({ ...COMMON_ROUTES, ...ROUTES }, createState());
        for (const url of URLS) {
            const res = await fetchDemo(url, { method: 'GET' });
            expect(res.status, `${url} → ${res.status}`).toBe(200);
            const body = await res.json();
            expect(body, `${url} answered nothing`).toBeTruthy();
        }
    });

    it('still fails closed for a url nobody fixtured', async () => {
        const fetchDemo = createDemoTransport({ ...COMMON_ROUTES, ...ROUTES }, createState());
        const res = await fetchDemo('/api/compliance/not-a-thing', { method: 'GET' });
        expect(res.status).toBe(404);
    });
});

describe('compliance fixture — writes stay in the tab', () => {
    it('marking the ROPA reviewed updates the settings the page reads back', () => {
        const c = ctx();
        const before = ROUTES['GET /api/compliance/ropa'](c).last_reviewed_at;
        const res = ROUTES['POST /api/compliance/ropa/review'](c);
        expect(res.reviewed_at).toBeTruthy();
        expect(c.state.settings.ropa_reviewed_at).not.toBe(before);
    });

    it('recording an incident starts a real 72-hour clock', () => {
        const c = ctx({ body: { title: 'Test', severity: 'low' } });
        const created = ROUTES['POST /api/compliance/incidents'](c);
        const delta = new Date(created.deadline_at).getTime() - new Date(created.detected_at).getTime();
        expect(delta).toBe(72 * 3_600_000);
        expect(ROUTES['GET /api/compliance/incidents'](c)[0].id).toBe(created.id);
    });

    it('notifying recipients says nothing was actually sent', () => {
        // The demo has no network. A silent success would tell a visitor an
        // email went out to a breach-notification list.
        const c = ctx({ params: { id: '31' } });
        expect(ROUTES['POST /api/compliance/incidents/:id/notify-recipients'](c).demo_not_sent).toBe(true);
    });
});

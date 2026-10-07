import { describe, it, expect } from 'vitest';
import { createState, ROUTES } from './compliance';
import { ISO_CONNECTORS } from './complianceCatalog';
import { addCalendarMonths } from '../../components/shared/deadlineMath';

/**
 * The Compliance demo answers in the server's shapes and vocabularies.
 *
 * compliance.test.js pins that the fixture agrees with ITSELF; this file pins
 * that it agrees with the SERVER, field by field where a mismatch shows on
 * screen: string ids printed "#dsr_2414" and "INC-inc_32", access-log actions
 * as bare strings drew eight empty filter pills, connector states keyed to ids
 * the catalogue does not have never showed, and "privacy" was a risk category
 * the register has no word for. The enums below are copied from the server
 * file each comment names; the server cannot be imported here.
 */

type Row = Record<string, unknown>;
type Ctx = { state: ReturnType<typeof createState>; query: URLSearchParams; params: Record<string, string>; body: Row | null };
const routes = ROUTES as unknown as Record<string, (ctx: Ctx) => unknown>;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ state: createState(), query: new URLSearchParams(), params: {}, body: null, ...over });
const call = <T = Row>(route: string, over: Partial<Ctx> = {}) => routes[route](ctx(over)) as T;
const isInt = (v: unknown) => typeof v === 'number' && Number.isInteger(v);

// routes/compliance/isoProcess.js
const RISK_STATUSES = ['open', 'treating', 'accepted', 'closed'];
const TREATMENT_OPTIONS = ['mitigate', 'transfer', 'avoid', 'accept'];
const OBLIGATION_KINDS = ['policy_review', 'soa_review', 'internal_audit', 'management_review', 'training', 'access_review', 'supplier_review', 'pentest', 'custom'];
// pages/risks/RisksTable.jsx CATEGORIES, the words the server's seeds use (iso/risks/seed)
const RISK_CATEGORIES = ['confidentiality', 'integrity', 'availability', 'compliance'];
// stores/incidentStore.js
const INCIDENT_STATUSES = ['open', 'assessing', 'early_warning_sent', 'authority_notified', 'reported', 'subjects_notified', 'closed'];
const INCIDENT_REGIMES = ['GDPR', 'NIS2', 'CRA', 'DORA'];

describe('compliance demo — ids are the numbers the SERIAL columns hand out', () => {
    it('requests 2413–2417 and incidents 29–32, printed as "#2414" and "INC-31"', () => {
        const dsr = call<Row[]>('GET /api/dsr/requests');
        expect(dsr.map(r => r.id).sort()).toEqual([2413, 2414, 2415, 2416, 2417]);
        const incidents = call<Row[]>('GET /api/compliance/incidents');
        expect(incidents.map(i => i.id)).toEqual([32, 31, 30, 29]);
        const refs = call<{ items: Row[] }>('GET /api/compliance/deadlines').items.map(i => i.ref);
        expect(refs).toEqual(expect.arrayContaining(['#2416', '#2417', 'INC-31', 'INC-32']));
        expect(refs.join(' ')).not.toMatch(/dsr_|inc_/);
    });

    it('every register row, and every reference between them, is a number', () => {
        const c = ctx();
        const { risks, treatments } = routes['GET /api/compliance/iso/risks'](c) as { risks: Row[]; treatments: Row[] };
        const audit = routes['GET /api/compliance/iso/audit'](c) as Record<string, Row[]>;
        const rows = [...risks, ...treatments, ...audit.audits, ...audit.findings, ...audit.ncs, ...audit.reviews, ...audit.objectives,
            ...(routes['GET /api/compliance/iso/training'](c) as { obligations: Row[] }).obligations,
            ...(routes['GET /api/compliance/dpia'](c) as Row[])];
        for (const r of rows) expect(isInt(r.id), JSON.stringify(r).slice(0, 80)).toBe(true);
        const riskIds = new Set(risks.map(r => r.id));
        for (const t of treatments) expect(riskIds.has(t.risk_id), `treatment ${t.id}`).toBe(true);
        const auditIds = new Set(audit.audits.map(a => a.id));
        const ncIds = new Set(audit.ncs.map(n => n.id));
        for (const f of audit.findings) {
            expect(auditIds.has(f.audit_id), `finding ${f.id}`).toBe(true);
            if (f.nonconformity_id != null) expect(ncIds.has(f.nonconformity_id), `finding ${f.id}`).toBe(true);
        }
        for (const e of (routes['GET /api/compliance/evidence'](c) as { rows: Row[] }).rows) expect(isInt(e.id)).toBe(true);
    });

    it('a route reached with a string param finds the numeric row, and a new row takes the next number', () => {
        const c = ctx();
        expect((routes['GET /api/dsr/requests/:id']({ ...c, params: { id: '2416' } }) as Row).id).toBe(2416);
        const created = routes['POST /api/dsr/requests/manual']({ ...c, body: { subject_email: 'n.visser@example.nl', request_type: 'access' } }) as Row;
        expect(created.id).toBe(2418);
        const incident = routes['POST /api/compliance/incidents']({ ...c, body: { title: 'Laptop left on a train', severity: 'low' } }) as Row;
        expect(incident.id).toBe(33);
    });
});

describe('compliance demo — the incident register as incidentStore keeps it', () => {
    it('statuses and regimes are the store\'s, the log is [{ at, by, text }] and every row is stamped', () => {
        for (const i of call<Row[]>('GET /api/compliance/incidents')) {
            expect(INCIDENT_STATUSES).toContain(i.status);
            for (const r of i.regimes as string[]) expect(INCIDENT_REGIMES).toContain(r);
            expect(Array.isArray(i.notes)).toBe(true);
            for (const n of i.notes as Row[]) expect(Object.keys(n).sort()).toEqual(['at', 'by', 'text']);
            expect(i.created_at).toBeTruthy();
            expect(new Date(i.updated_at as string).getTime()).toBeGreaterThanOrEqual(new Date(i.detected_at as string).getTime());
            expect(i).not.toHaveProperty('notification_due_at');
        }
    });

    it('a note joins the log, and recording the authority notification empties a GDPR breach\'s deadline', () => {
        const c = ctx({ params: { id: '31' } });
        const noted = routes['PATCH /api/compliance/incidents/:id']({ ...c, body: { note: 'Called the broker again.' } }) as Row;
        expect((noted.notes as Row[]).at(-1)).toMatchObject({ by: 'u_marieke', text: 'Called the broker again.' });
        const filed = routes['PATCH /api/compliance/incidents/:id']({ ...c, body: { status: 'authority_notified', authority_reference: 'AP-1' } }) as Row;
        expect(filed.authority_notified_at).toBeTruthy();
        expect(filed.authority_notified_by).toBe('u_marieke');
        expect(filed.deadline_at).toBeNull();
    });

    it('stamping the DORA customer notice moves the deadline on to the 72-hour notification', () => {
        const c = ctx({ params: { id: '32' } });
        const before = (routes['GET /api/compliance/incidents'](c) as Row[]).find(i => i.id === 32) as Row;
        const after = routes['POST /api/compliance/incidents/:id/customer-notified'](c) as Row;
        expect(after.customer_notice_due_at).toBe(before.customer_notice_due_at);
        expect(new Date(after.deadline_at as string).getTime() - new Date(after.detected_at as string).getTime()).toBe(72 * 3_600_000);
    });
});

describe('compliance demo — /counts in the shape counts.js sends', () => {
    it('incidents: the open count, the next clock with its stage, whole hours rounded up', () => {
        const counts = call<Record<string, Row>>('GET /api/compliance/counts');
        expect(Object.keys(counts.incidents).sort()).toEqual(['hours_left', 'next_deadline_at', 'next_stage', 'open', 'vulnerabilities_open']);
        expect(counts.incidents).toMatchObject({ open: 2, next_stage: 'customer_notice', hours_left: 1, vulnerabilities_open: null });
    });

    it('risks.high is the register\'s own count: score 10 or more, closed ones left out', () => {
        const c = ctx();
        const { risks } = routes['GET /api/compliance/iso/risks'](c) as { risks: Row[] };
        const high = risks.filter(r => (r.score as number) >= 10 && r.status !== 'closed').length;
        expect((routes['GET /api/compliance/counts'](c) as Record<string, Row>).risks).toEqual({ total: risks.length, high });
    });
});

describe('compliance demo — vocabularies the pages translate', () => {
    it('risk categories, statuses and treatment options are the server\'s words', () => {
        const { risks, treatments } = call<{ risks: Row[]; treatments: Row[] }>('GET /api/compliance/iso/risks');
        for (const r of risks) {
            expect(RISK_CATEGORIES).toContain(r.category);
            expect(RISK_STATUSES).toContain(r.status);
        }
        for (const t of treatments) expect(TREATMENT_OPTIONS).toContain(t.option);
    });

    it('obligations are open rows of the server\'s kinds, one per kind and subject, and land on Training', () => {
        const c = ctx();
        const { obligations } = routes['GET /api/compliance/iso/training'](c) as { obligations: Row[] };
        for (const o of obligations) {
            expect(OBLIGATION_KINDS).toContain(o.kind);
            expect(o.completed_at).toBeNull();
        }
        expect(new Set(obligations.map(o => `${o.kind}|${o.subject}`)).size).toBe(obligations.length);
        const late = (routes['GET /api/compliance/attention']({ ...c, query: new URLSearchParams('limit=50') }) as { items: Row[] })
            .items.filter(i => i.code === 'obligation_overdue');
        expect(late.length).toBeGreaterThan(0);
        for (const i of late) expect((i.action as Row).target).toBe('/app/admin/compliance/training');
        // Completing a recurring obligation opens its next occurrence.
        const done = routes['POST /api/compliance/iso/obligations/:id/complete']({ ...c, params: { id: '2' } }) as { completed: Row; next: Row };
        expect(done.completed.completed_at).toBeTruthy();
        expect(done.next.kind).toBe('access_review');
        expect((routes['GET /api/compliance/iso/training'](c) as { obligations: Row[] }).obligations.map(o => o.id)).toContain(done.next.id);
    });

    it('management review attendees are { id, name }', () => {
        for (const r of call<{ reviews: Row[] }>('GET /api/compliance/iso/audit').reviews) {
            for (const a of r.attendees as Row[]) expect(Object.keys(a).sort()).toEqual(['id', 'name']);
        }
    });

    it('every policy carries its working draft; a published one\'s draft is its text unless the owner changed it', () => {
        const c = ctx();
        const { documents } = routes['GET /api/compliance/iso/docs'](c) as { documents: Row[] };
        for (const d of documents) {
            expect(typeof d.draft_body, `${d.slug}`).toBe('string');
            expect(d).not.toHaveProperty('published_body');
        }
        const changed = documents.filter(d => d.status === 'published').filter((d) => {
            const detail = routes['GET /api/compliance/iso/docs/:slug']({ ...c, params: { slug: d.slug as string } }) as Row;
            return detail.draft_body !== (detail.published as Row).body;
        }).map(d => d.slug);
        expect(changed).toEqual(['information-security-policy']);
    });
});

describe('compliance demo — the access log', () => {
    it('the filter options are { action, count, last_at }, newest first, and add up to the log', () => {
        const c = ctx();
        const { actions } = routes['GET /api/compliance/access-audit/actions'](c) as { actions: Row[] };
        const { total } = routes['GET /api/compliance/access-audit'](c) as { total: number };
        expect(new Set(actions.map(a => a.action)).size).toBe(actions.length);
        for (const a of actions) expect(Object.keys(a).sort()).toEqual(['action', 'count', 'last_at']);
        expect(actions.reduce((n, a) => n + (a.count as number), 0)).toBe(total);
        const stamps = actions.map(a => a.last_at as string);
        expect([...stamps].sort().reverse()).toEqual(stamps);
    });

    it('rows name accounts by id and refused sign-ins by fingerprint, never by address', () => {
        const { entries } = call<{ entries: Row[] }>('GET /api/compliance/access-audit');
        expect(JSON.stringify(entries)).not.toMatch(/[\w.]+@[\w.]+\.\w+/);
        for (const e of entries.filter(x => x.action === 'login_failed' || x.action === 'login_blocked')) {
            expect(e.target_type).toBe('login_identifier');
            expect(e.changed_by).toBe('anonymous');
        }
    });

    it('filters by action list and by actor, like routes/compliance/accessAudit.js', () => {
        const byAction = call<{ entries: Row[] }>('GET /api/compliance/access-audit', { query: new URLSearchParams('action=login_failed,login_blocked') });
        expect(byAction.entries.map(e => e.action).sort()).toEqual(['login_blocked', 'login_failed']);
        const byActor = call<{ entries: Row[] }>('GET /api/compliance/access-audit', { query: new URLSearchParams('actor=u_joost') });
        expect(byActor.entries.every(e => e.changed_by === 'u_joost')).toBe(true);
        expect(byActor.entries.length).toBe(2);
    });
});

describe('compliance demo — evidence connectors', () => {
    it('states sit on catalogue ids, in the collector\'s words: ok, or error with its message', () => {
        const rows = call<Row[]>('GET /api/compliance/iso/connectors');
        const ids = new Set(ISO_CONNECTORS.map(c => c.id));
        const configured = rows.filter(r => r.config);
        expect(configured.length).toBeGreaterThan(3);
        for (const r of rows) {
            expect(ids.has(r.id as string)).toBe(true);
            expect(typeof r.snapshots).toBe('number');
            const cfg = r.config as Row | null;
            if (!cfg) continue;
            expect(['ok', 'error']).toContain(cfg.last_status);
            expect(!!cfg.last_error, `${r.id}`).toBe(cfg.last_status === 'error');
        }
        expect((rows.find(r => r.id === 'github')?.config as Row).last_status).toBe('error');
    });
});

describe('compliance demo — collaborative projects in the processing register', () => {
    it('GET /ropa/projects lists one project with a record and one without, special categories first', () => {
        const body = call<{ projects: Row[]; complete: boolean }>('GET /api/compliance/ropa/projects');
        expect(body.complete).toBe(true);
        expect(body.projects.map(p => [p.project_id, !!p.registration, p.special])).toEqual([
            ['prj_schadedossiers', true, true],
            ['prj_makelaars', false, false],
        ]);
    });

    it('recording a project re-judges its check and adds a link to the evidence chain; removing an absent record is a 404', () => {
        const c = ctx();
        const row = () => c.state.checks.find((x: Row) => x.check_id === 'GDPR-Art30-project-personal-data' && x.scope_id === 'project:prj_makelaars');
        expect(row().status).toBe('warn');
        const before = c.state.evidence.length;
        const bad = routes['PUT /api/compliance/ropa/projects/:projectId']({ ...c, params: { projectId: 'prj_makelaars' }, body: { lawful_basis: 'because' } }) as Response;
        expect(bad.status).toBe(400);
        const saved = routes['PUT /api/compliance/ropa/projects/:projectId']({ ...c, params: { projectId: 'prj_makelaars' }, body: { lawful_basis: 'legitimate_interests', purpose: 'Broker coordination' } }) as { registration: Row };
        expect(saved.registration).toMatchObject({ subject_id: 'prj_makelaars', lawful_basis: 'legitimate_interests' });
        expect(row().status).toBe('pass');
        expect(c.state.evidence.length).toBe(before + 1);
        expect((routes['GET /api/compliance/ropa'](c) as { activities: Row[] }).activities.some(a => a.activity_id === 'project:prj_makelaars')).toBe(true);
        expect((routes['DELETE /api/compliance/ropa/projects/:projectId']({ ...c, params: { projectId: 'prj_makelaars' } }) as Row).removed).toBe(true);
        expect((routes['DELETE /api/compliance/ropa/projects/:projectId']({ ...c, params: { projectId: 'prj_makelaars' } }) as Response).status).toBe(404);
    });
});

// compliance/deadlines.js KINDS, in its order (the order of `empty_kinds`).
const DEADLINE_KINDS = ['dsr', 'incident', 'cra_early_warning', 'cra_notification', 'cra_full_report', 'obligation', 'attestation_expiry'];
const HOUR = 3_600_000;
type Deadline = { id: string; kind: string; ref: string; state: string; due_at: string | null; meta: Row & { article: string | null } };
type Attention = { id: string; code: string; status: string; meta: { detail: string | null; frameworks: { regulation: string; ref: string }[] } };
const deadlines = (c: Ctx) => routes['GET /api/compliance/deadlines'](c) as { items: Deadline[]; empty_kinds: string[] };
const attention = (c: Ctx) => (routes['GET /api/compliance/attention']({ ...c, query: new URLSearchParams('limit=50') }) as { items: Attention[] }).items;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
const ms = (v: unknown) => new Date(v as string).getTime();

/** A CRA row needs the CRA switched on, as on the server. */
function withCra(): Ctx {
    const c = ctx();
    routes['POST /api/compliance/frameworks/:id/enable']({ ...c, params: { id: 'cra' } });
    return c;
}
const record = (c: Ctx, body: Row) => routes['POST /api/compliance/incidents']({ ...c, body }) as Row;
const clocksOf = (c: Ctx, id: unknown) => deadlines(c).items.filter(i => i.ref === `INC-${id}`);

describe('compliance demo — the clocks and citations of compliance/deadlines.js', () => {
    it('cites each clock in full, per regime, and nothing for an attestation expiry', () => {
        const d = deadlines(ctx());
        expect([...d.empty_kinds]).toEqual(DEADLINE_KINDS.filter(k => d.empty_kinds.includes(k)));
        expect(d.empty_kinds).toContain('cra_notification');
        const byId = Object.fromEntries(d.items.map(i => [i.id, i]));
        expect(byId['dsr:2417'].meta.article).toBe('GDPR Art. 12(3)');
        // The DORA customer notice is the provider's contractual clock, cited beside GDPR Art. 33.
        expect(byId['incident:32'].meta).toMatchObject({ article: 'GDPR Art. 33 · DORA Art. 30(3)(b)', regimes: ['GDPR', 'DORA'] });
        expect(byId['incident:31'].meta.article).toBe('GDPR Art. 33');
        const expiry = d.items.filter(i => i.kind === 'attestation_expiry');
        expect(expiry.length).toBeGreaterThan(0);
        for (const i of expiry) expect(i.meta.article).toBeNull();
    });

    it('a vulnerability runs the three Art. 14(2) clocks, the notification urgent with 24 hours left', () => {
        const c = withCra();
        const v = record(c, { kind: 'vulnerability', title: 'Auth bypass in the broker portal', detected_at: hoursAgo(50) });
        const clocks = clocksOf(c, v.id);
        expect(clocks.map(i => i.kind).sort()).toEqual(['cra_early_warning', 'cra_full_report', 'cra_notification']);
        const by = Object.fromEntries(clocks.map(i => [i.kind, i]));
        expect(by.cra_early_warning.meta).toMatchObject({ article: 'CRA Art. 14(2)(a)', stage: 'early_warning' });
        expect(by.cra_early_warning.state).toBe('overdue');
        expect(by.cra_notification.meta).toMatchObject({ article: 'CRA Art. 14(2)(b)', stage: 'notification' });
        expect(ms(by.cra_notification.due_at) - ms(v.detected_at)).toBe(72 * HOUR);
        expect(by.cra_notification.state).toBe('urgent');
        expect(by.cra_full_report.meta).toMatchObject({ article: 'CRA Art. 14(2)(c)', stage: 'full' });
        expect(ms(by.cra_full_report.due_at) - ms(v.detected_at)).toBe(14 * 24 * HOUR);
        // 32 hours left on a 72-hour notification is not yet urgent.
        const later = record(c, { kind: 'vulnerability', title: 'Second finding', detected_at: hoursAgo(40) });
        expect(clocksOf(c, later.id).find(i => i.kind === 'cra_notification')?.state).toBe('ok');
    });

    it('a severe incident under the CRA cites Art. 14(4), its final report runs a month from the notification, and GDPR keeps its own item', () => {
        const c = withCra();
        const row = record(c, { kind: 'security_incident', regimes: ['GDPR', 'CRA'], title: 'Ransomware on the policy server', detected_at: hoursAgo(10) });
        const by = Object.fromEntries(clocksOf(c, row.id).map(i => [i.kind, i]));
        expect(Object.keys(by).sort()).toEqual(['cra_early_warning', 'cra_full_report', 'cra_notification', 'incident']);
        expect(by.cra_early_warning.meta.article).toBe('CRA Art. 14(4)(a)');
        expect(by.cra_notification.meta.article).toBe('CRA Art. 14(4)(b)');
        expect(by.cra_full_report.meta.article).toBe('CRA Art. 14(4)(c)');
        expect(ms(by.cra_full_report.due_at)).toBe(addCalendarMonths(ms(row.detected_at) + 72 * HOUR, 1));
        // The authority item tracks the non-CRA regimes only: GDPR's 72 hours, not the CRA 24-hour early warning.
        expect(by.incident.meta).toMatchObject({ article: 'GDPR Art. 33', regimes: ['GDPR'] });
        expect(ms(by.incident.due_at) - ms(row.detected_at)).toBe(72 * HOUR);
        // Recording the notification meets both notification clocks and re-dates the final report.
        const filed = routes['PATCH /api/compliance/incidents/:id']({ ...c, params: { id: String(row.id) }, body: { status: 'authority_notified' } }) as Row;
        expect(ms(filed.final_report_due_at)).toBe(addCalendarMonths(filed.authority_notified_at as string, 1));
        expect(clocksOf(c, row.id).map(i => i.kind).sort()).toEqual(['cra_early_warning', 'cra_full_report']);
    });

    it('a NIS2 final report is one calendar month in, clamped to the end of a short month', () => {
        const c = ctx();
        const row = record(c, { kind: 'security_incident', regimes: ['NIS2'], title: 'Outage', detected_at: '2026-01-31T10:00:00.000Z' });
        expect(row.final_report_due_at).toBe('2026-02-28T10:00:00.000Z');
    });
});

describe('compliance demo — the register findings of compliance/attention.js', () => {
    it('a DSR due soon and an overdue one carry the one-month wording', () => {
        const c = ctx();
        const soon = attention(c).find(i => i.id === 'register:dsr:2417:due_soon');
        expect(soon?.meta.detail).toBe('Fulfil or extend (once, by two further months, with a reason) before the deadline.');
        const late = routes['POST /api/dsr/requests/manual']({ ...c, body: { subject_email: 'l.bos@example.nl', request_type: 'access', received_at: hoursAgo(50 * 24) } }) as Row;
        const overdue = attention(c).find(i => i.id === `register:dsr:${late.id}:overdue`);
        expect(overdue?.status).toBe('fail');
        expect(overdue?.meta.detail).toMatch(/^The response deadline \(one month from receipt, or the extended deadline\) passed \d+ day\(s\) ago\.$/);
        // An overdue request is not also flagged as due soon or unverified.
        expect(attention(c).filter(i => i.id.startsWith(`register:dsr:${late.id}:`)).length).toBe(1);
    });

    it('an expired self-assessment cites the article its outcome rests on, Art. 6 by default', () => {
        const c = ctx();
        const expired = (c.state.aiAct as Row[]).find(a => ms(a.expires_at) < Date.now()) as Row;
        const refOf = (outcome: string) => {
            expired.outcome = outcome;
            const item = attention(c).find(i => i.code === 'ai_act_attestation_expired');
            return item?.meta.frameworks[0];
        };
        expect(refOf('transparency')).toEqual({ regulation: 'AIA', ref: 'Art. 50' });
        expect(refOf('high_risk')?.ref).toBe('Art. 6');
        expect(refOf('prohibited')?.ref).toBe('Art. 5');
        expect(refOf('minimal')?.ref).toBe('Art. 6');
    });

    it('a CRA early warning due within 6 hours cites Art. 14(2)(a) for a vulnerability and Art. 14(4)(a) for a severe incident', () => {
        const c = withCra();
        const v = record(c, { kind: 'vulnerability', title: 'Exploited CVE', detected_at: hoursAgo(20) });
        const s = record(c, { kind: 'security_incident', regimes: ['CRA'], title: 'Severe incident', detected_at: hoursAgo(26) });
        const items = attention(c);
        const vItem = items.find(i => i.id === `register:incident:${v.id}:cra_early_warning`);
        expect(vItem?.status).toBe('warn');
        expect(vItem?.meta.frameworks).toEqual([{ regulation: 'CRA', ref: 'Art. 14(2)(a)' }]);
        expect(vItem?.meta.detail).toContain('actively exploited vulnerability');
        const sItem = items.find(i => i.id === `register:incident:${s.id}:cra_early_warning`);
        expect(sItem?.status).toBe('fail');
        expect(sItem?.meta.frameworks).toEqual([{ regulation: 'CRA', ref: 'Art. 14(4)(a)' }]);
        expect(sItem?.meta.detail).toContain('severe incident affecting the security of the product');
    });

    it('a running notification clock with no breach recipients is flagged, as the server does', () => {
        const c = ctx();
        c.state.settings = { ...c.state.settings, breach_recipients: [] };
        const ids = attention(c).filter(i => i.code === 'incident_no_breach_recipients').map(i => i.id).sort();
        expect(ids).toEqual(['register:incident:31:no_recipients', 'register:incident:32:no_recipients']);
    });
});

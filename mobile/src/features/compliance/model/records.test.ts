/**
 * The register registry: every type reads its payload, and every write it
 * can build is the exact request the server's schema takes.
 */

import { initialValues } from './fields';
import { AUDITS, NCS, OBJECTIVES, REVIEWS } from './recordsAudit';
import { CUSTOM, MACHINERY, checkRows } from './recordsCustom';
import { captureBody, DSR_REQUESTS } from './recordsDsr';
import { incidentCreateBody, INCIDENTS, parseCveIds, parseProducts, VULNERABILITIES } from './recordsIncidents';
import { POLICIES, RISKS, SOA } from './recordsIso';
import { CONNECTORS, defaultExpiry, DPIA, dpiaRows, questionnaireBody } from './recordsMisc';
import { OBLIGATIONS, PERSONNEL } from './recordsTraining';
import { RECORD_TYPES, recordType, typesOfSection } from './registry';
import { SECTIONS } from './sections';
import type { ActionSpec, Formatter, Rec, RequestContext } from './types';

const t = (_key: string, fallback: string) => fallback;
const fmt: Formatter = { t, date: (v) => (typeof v === 'string' ? v.slice(0, 10) : null), user: (id) => (typeof id === 'string' ? id : null) };
const ctx: RequestContext = { t, context: null, now: Date.UTC(2026, 8, 1) };
const action = (list: readonly ActionSpec[] | undefined, id: string): ActionSpec => {
    const found = list?.find((a) => a.id === id);
    if (!found) throw new Error(`no action ${id}`);
    return found;
};

describe('the registry', () => {
    it('has one entry per id, and every records section resolves its types', () => {
        expect(new Set(RECORD_TYPES.map((x) => x.id)).size).toBe(RECORD_TYPES.length);
        for (const section of SECTIONS.filter((s) => s.view === 'records')) {
            expect(typesOfSection(section).length).toBe(section.types?.length);
        }
        expect(recordType('ncs')).toBe(NCS);
        expect(recordType('nope')).toBeNull();
    });

    it('reads a junk payload as an empty register, never a throw', () => {
        for (const type of RECORD_TYPES) {
            const set = type.list.select(type.list.paths.map(() => '<html>'));
            expect(set.rows).toEqual([]);
        }
    });
});

describe('incidents', () => {
    const payload = [
        { id: 4, kind: 'breach', title: 'Laptop lost', status: 'open', severity: 'high', high_risk: true, detected_at: '2026-09-01T10:00:00Z' },
        { id: 5, kind: 'vulnerability', title: 'CVE in parser', status: 'open', early_warning_sent_at: '2026-09-01T11:00:00Z', cve_ids: ['CVE-1'] },
    ];

    it('splits the kinds between the two registers', () => {
        expect(INCIDENTS.list.select([payload]).rows.map((r) => r.id)).toEqual(['4']);
        expect(VULNERABILITIES.list.select([payload]).rows.map((r) => r.id)).toEqual(['5']);
    });

    it('builds the web create body for each kind', () => {
        const v = { title: ' Lost ', description: '', severity: 'critical', occurred_at: '2026-09-01', high_risk: true, cve_ids: 'cve-1, CVE-1 cve-2', affected_products: 'app 1.x\nlib', exploited_in_wild: true };
        expect(incidentCreateBody(v, 'breach')).toEqual({ kind: 'breach', title: 'Lost', severity: 'critical', occurred_at: '2026-09-01', high_risk: true });
        expect(incidentCreateBody(v, 'vulnerability')).toEqual({
            kind: 'vulnerability',
            title: 'Lost',
            severity: 'critical',
            occurred_at: '2026-09-01',
            cve_ids: ['CVE-1', 'CVE-2'],
            exploited_in_wild: true,
            affected_products: [{ name: 'app', version_range: '1.x' }, { name: 'lib' }],
        });
        expect(parseCveIds(null)).toEqual([]);
        expect(parseProducts('')).toEqual([]);
    });

    it('offers each stamp while it is missing, with the exact request', () => {
        const [breach] = INCIDENTS.list.select([payload]).rows as Rec[];
        const b = breach as Rec;
        expect(action(INCIDENTS.actions, 'assess').request?.(b, {}, ctx)).toEqual({ method: 'PATCH', path: '/api/compliance/incidents/4', body: { status: 'assessing' } });
        expect(action(INCIDENTS.actions, 'authority').request?.(b, { authority_reference: ' AP-1 ' }, ctx)).toEqual({
            method: 'PATCH',
            path: '/api/compliance/incidents/4',
            body: { status: 'authority_notified', authority_reference: 'AP-1' },
        });
        expect(action(INCIDENTS.actions, 'subjects').when?.(b)).toBe(true);
        expect(action(INCIDENTS.actions, 'notify').request?.(b, {}, ctx)).toEqual({ method: 'POST', path: '/api/compliance/incidents/4/notify-recipients', body: {} });
        expect(action(INCIDENTS.actions, 'close').request?.(b, {}, ctx).body).toEqual({ status: 'closed', note: 'Closed after assessment.' });
    });

    it('reports a vulnerability in the two stages the server knows', () => {
        const vuln = VULNERABILITIES.list.select([payload]).rows[0] as Rec;
        expect(action(VULNERABILITIES.actions, 'early_warning').when?.(vuln)).toBe(false);
        const full = action(VULNERABILITIES.actions, 'full');
        expect(full.when?.(vuln)).toBe(true);
        expect(full.request?.(vuln, { reported_via: 'ENISA', reference: '' }, ctx)).toEqual({
            method: 'POST',
            path: '/api/compliance/incidents/5/cra-report',
            body: { stage: 'full', reported_via: 'ENISA' },
        });
    });
});

describe('data-subject requests', () => {
    const rows = DSR_REQUESTS.list.select([[{ id: 9, request_type: 'deletion', status: 'pending', subject_email_masked: 'j***@x.nl', identity_status: 'unverified' }]]).rows;
    const r = rows[0] as Rec;

    it('titles a request by number and kind, and never reads the address', () => {
        expect(DSR_REQUESTS.titleOf(r, fmt)).toBe('#9 · Deletion request');
        expect(r).not.toHaveProperty('subject_email');
    });

    it('captures a request with a lower-cased address and an ISO receipt', () => {
        const body = captureBody({ request_type: 'access', subject_email: ' Jan@X.nl ', channel: 'letter', received_at: '2026-09-01', notes: '' });
        expect(body).toMatchObject({ request_type: 'access', subject_email: 'jan@x.nl', channel: 'letter' });
        expect(typeof body.received_at).toBe('string');
        expect(body).not.toHaveProperty('notes');
    });

    it('fulfils, rejects, extends and verifies with the schema bodies', () => {
        expect(action(DSR_REQUESTS.actions, 'fulfil').request?.(r, { result_summary: ' Done ' }, ctx)).toEqual({
            method: 'POST',
            path: '/api/dsr/requests/9/fulfil',
            body: { status: 'fulfilled', result_summary: 'Done', notify_subject: true },
        });
        expect(action(DSR_REQUESTS.actions, 'reject').request?.(r, { result_summary: 'No' }, ctx)?.body).toEqual({ status: 'rejected', result_summary: 'No', notify_subject: true });
        expect(action(DSR_REQUESTS.actions, 'extend').request?.(r, { reason: ' busy ' }, ctx)?.body).toEqual({ reason: 'busy' });
        expect(action(DSR_REQUESTS.actions, 'verify').request?.(r, { note: '' }, ctx)?.body).toEqual({ method: 'manual' });
        expect(action(DSR_REQUESTS.actions, 'export').download?.(r)).toEqual({ path: '/api/dsr/requests/9/export', fileName: 'dsr-9.json', mimeType: 'application/json' });
        expect(DSR_REQUESTS.history?.select({ id: 9, timeline: [{ kind: 'received', at: '2026-09-01T00:00:00Z' }] }, fmt)).toEqual([{ id: '0', title: 'received', meta: '2026-09-01' }]);
    });
});

describe('ISO registers', () => {
    it('joins a risk with its treatments and accepts it', () => {
        const set = RISKS.list.select([{ risks: [{ id: 1, title: 'Leak', status: 'open' }], treatments: [{ id: 2, risk_id: 1, option: 'mitigate' }, { id: 3, risk_id: 9 }] }]);
        const risk = set.rows[0] as Rec;
        expect((risk.treatments as unknown[]).length).toBe(1);
        expect(action(RISKS.actions, 'accept').request?.(risk, {}, ctx)).toEqual({ method: 'PUT', path: '/api/compliance/iso/risks/1', body: { status: 'accepted' } });
        expect(RISKS.create?.request({ ...initialValues(RISKS.create.fields), title: 'X' }, ctx).body).toEqual({ title: 'X', likelihood: 3, impact: 3 });
        expect(RISKS.related?.titleOf({ option: 'transfer' }, fmt)).toBe('Transfer');
    });

    it('flattens the SoA controls and seeds only while rows are missing', () => {
        const set = SOA.list.select([{ controls: [{ ref: 'A.5.1', theme: 5, titleKey: 'k', entry: null }, { ref: 'A.5.2', theme: 5, entry: { status: 'approved', applicable: false } }] }]);
        expect(set.rows.map((r) => [r.ref, r.theme, r.status, r.applicable, r.seeded])).toEqual([['A.5.1', '5', 'todo', true, false], ['A.5.2', '5', 'approved', false, true]]);
        expect(SOA.listActions?.find((a) => a.id === 'seed')?.when?.(set)).toBe(true);
        expect(SOA.edit?.request(set.rows[0] as Rec, { how_met: 'MFA' }, ctx)).toEqual({ method: 'PUT', path: '/api/compliance/iso/soa/A.5.1', body: { how_met: 'MFA' } });
    });

    it('keeps the missing-template count and publishes a policy', () => {
        const set = POLICIES.list.select([{ documents: [{ slug: 'isp', title: 'ISP', status: 'draft' }], missing_seeds: [{ slug: 'x', title: 'X' }] }]);
        expect(POLICIES.listActions?.find((a) => a.id === 'seed')?.when?.(set)).toBe(true);
        expect(action(POLICIES.actions, 'publish').request?.(set.rows[0] as Rec, {}, ctx)).toEqual({ method: 'POST', path: '/api/compliance/iso/docs/isp/publish', body: {} });
        expect(POLICIES.detail?.path('isp')).toBe('/api/compliance/iso/docs/isp');
    });
});

describe('audits and training', () => {
    const bundle = { audits: [{ id: 1, title: 'Q3', status: 'planned' }], findings: [{ id: 2, audit_id: 1, description: 'gap' }], reviews: [{ id: 3, held_at: '2026-06-01' }], ncs: [{ id: 4, title: 'NC', status: 'effectiveness_review' }], objectives: [{ id: 5, title: 'O', status: 'dropped' }], mr_inputs: { score_now: 80 } };

    it('moves each row along its workflow', () => {
        const audit = AUDITS.list.select([bundle]).rows[0] as Rec;
        expect((audit.findings as unknown[]).length).toBe(1);
        expect(AUDITS.actions?.find((a) => a.when?.(audit))?.request?.(audit, {}, ctx)).toEqual({ method: 'PUT', path: '/api/compliance/iso/audits/1', body: { status: 'in_progress' } });
        const nc = NCS.list.select([bundle]).rows[0] as Rec;
        expect(NCS.actions?.find((a) => a.when?.(nc))?.request?.(nc, {}, ctx)?.body).toEqual({ status: 'closed', confirm_effectiveness: true });
        const objective = OBJECTIVES.list.select([bundle]).rows[0] as Rec;
        expect(OBJECTIVES.actions?.filter((a) => a.when?.(objective)).map((a) => a.id)).toEqual(['dropped-active']);
    });

    it('snapshots the review agenda into a new review', () => {
        const set = REVIEWS.list.select([bundle]);
        expect(REVIEWS.create?.request({ held_at: '2026-09-01', decisions: '', minutes_evidence_ref: '' }, { ...ctx, context: set.context }).body).toEqual({ held_at: '2026-09-01', inputs: { score_now: 80 } });
    });

    it('attests training and completes an obligation', () => {
        const payload = { personnel: [{ user_id: 'u1', displayName: 'Ann', policy_acks: 2, policy_total: 3, email: 'a@x.nl' }], obligations: [{ id: 7, title: 'Pentest', due_at: '2020-01-01' }] };
        const person = PERSONNEL.list.select([payload]).rows[0] as Rec;
        expect(person).toMatchObject({ acks: '2/3', trained: 'never' });
        expect(person).not.toHaveProperty('email');
        expect(action(PERSONNEL.actions, 'attest').request?.(person, { note: '' }, ctx)).toEqual({ method: 'POST', path: '/api/compliance/iso/training/u1/attest', body: {} });
        const obligation = OBLIGATIONS.list.select([payload]).rows[0] as Rec;
        expect(obligation.state).toBe('overdue');
        expect(OBLIGATIONS.edit?.request(obligation, { title: 'X' }, ctx)).toEqual({ method: 'PUT', path: '/api/compliance/iso/obligations/7', body: { title: 'X' } });
    });
});

describe('frameworks registers, connectors and DPIAs', () => {
    it('adds a custom item as a one-row array', () => {
        expect(checkRows({ ref: 'Q1', title: 'Backups', description: '', severity: 'high', evidence_required: false })).toEqual([{ ref: 'Q1', title: 'Backups', severity: 'high', evidence_required: false }]);
        expect(CUSTOM.remove?.request({ id: 'f1' })).toEqual({ method: 'DELETE', path: '/api/compliance/custom/frameworks/f1' });
        expect(CUSTOM.related?.actions?.[0]?.attest?.path({ id: 'c1' })).toBe('/api/compliance/custom/checks/c1/attest');
    });

    it('lists detections with the manual subjects, and declares one', () => {
        const rows = MACHINERY.list.select([{ matches: [{ subject_id: 'automation:3', label: 'PLC', assessment: { classification: 'monitoring_only' } }], manual_subjects: [{ subject_id: 'manual:press', label: 'Press' }, { label: 'no id' }] }]).rows;
        expect(rows.map((r) => [r.subject_id, r.classification])).toEqual([['automation:3', 'monitoring_only'], ['manual:press', null]]);
        expect(MACHINERY.actions?.[0]?.attest?.path(rows[0] as Rec)).toBe('/api/compliance/machinery/subjects/automation%3A3/attest');
    });

    it('derives a connector state and sweeps an enabled one', () => {
        const rows = CONNECTORS.list.select([[{ id: 'github', config: { enabled: true, last_status: 'error' } }, { id: 'aws', config: null }]]).rows;
        expect(rows.map((r) => r.state)).toEqual(['error', 'off']);
        expect(action(CONNECTORS.actions, 'sweep').when?.(rows[1] as Rec)).toBe(false);
    });

    it('builds DPIA rows from the Art. 35 check and records both paths', () => {
        const rows = dpiaRows(
            [{ check_id: 'GDPR-Art35-dpia-high-risk', scope_id: 'a1', status: 'fail', evidence: { agent_name: 'HR bot', risk_reason: 'HR data' } }, { check_id: 'other', scope_id: 'x' }],
            [{ agent_id: 'a1', mode: 'attestation', approved_at: '2026-01-01' }],
        );
        expect(rows).toEqual([{ agent_id: 'a1', agent_name: 'HR bot', risk_reason: 'HR data', status: 'fail', on_record: true, mode: 'attestation', risk_level: null, approved_at: '2026-01-01', expires_at: null }]);
        expect(DPIA.list.select([[], []]).rows).toEqual([]);
        expect(defaultExpiry(ctx.now).startsWith('2027-09-01')).toBe(true);
        const body = questionnaireBody({ purpose: 'HR', data_categories: '', automated_decisions: true, human_oversight: 'yes', mitigations: 'redact\n', risk_level: 'low' }, ctx.now);
        expect(body).toMatchObject({ mode: 'questionnaire', risk_level: 'low', answers: { purpose: 'HR', data_categories: '', automated_decisions: true, human_oversight: 'yes' }, mitigations: ['redact'] });
        expect(action(DPIA.actions, 'attest').request?.(rows[0] as Rec, {}, ctx)?.body).toMatchObject({ mode: 'attestation', risk_level: 'medium' });
    });
});

import {
    readAttentionList,
    readAutoFixResult,
    readCheckHistoryRows,
    readCheckRows,
    readDeadlineList,
    readEvidenceRows,
    readFrameworkList,
    readHubCounts,
    readRunResult,
} from './hubReaders';
import { readMembers } from './members';

const JUNK: unknown[] = [null, undefined, 'oops', 42, [], '<html>'];

describe('readHubCounts', () => {
    const counts = readHubCounts({
        attention_open: 3,
        last_run: { at: '2026-10-01T10:00:00Z', interval_hours: 6 },
        frameworks: { gdpr: { score: 82 } },
        frameworks_summary: { active: 4, candidates: 2, recently_in_force: 1, locked: 1 },
        dsr: { open: 2, overdue: 0, due_soon: 1 },
        incidents: { open: 1, next_deadline_at: '2026-10-02T10:00:00Z', next_stage: 'early_warning', hours_left: 20, vulnerabilities_open: null },
        soa: { approved: 10, total: 93, todo: 83 },
        evidence: { rows: 120, chain_ok: true, algorithm: 'SHA-256', checked_rows: 120 },
        onboarded: false,
        setup_step: 2,
    });

    it('reads the extra fields flat, next to the base counts', () => {
        expect(counts).toMatchObject({
            attentionOpen: 3,
            lastRunIntervalHours: 6,
            frameworksActive: 4,
            frameworksLocked: 1,
            dsr: { open: 2, overdue: 0 },
            dsrDueSoon: 1,
            incidentsNextDeadlineAt: '2026-10-02T10:00:00Z',
            incidentsNextStage: 'early_warning',
            soa: { approved: 10, total: 93 },
            soaTodo: 83,
            evidence: { rows: 120, chainOk: true, algorithm: 'SHA-256', checkedRows: 120 },
            setupStep: 2,
            scores: { gdpr: 82 },
        });
    });

    it('never invents a 0, and has no evidence footer when the key is absent', () => {
        const empty = readHubCounts({ dsr: { open: 1 } });
        expect(empty).toMatchObject({ dsrDueSoon: null, soaTodo: null, evidence: null, setupStep: null, lastRunIntervalHours: null });
        expect(readHubCounts({ evidence: { rows: 5, chain_ok: false } }).evidence?.chainOk).toBe(false);
    });

    it.each(JUNK.map((j) => [j]))('survives %p', (junk) => {
        expect(readHubCounts(junk)).toMatchObject({ attentionOpen: null, evidence: null, frameworksActive: null });
    });
});

describe('readAttentionList', () => {
    it('reads the meta and the action', () => {
        const list = readAttentionList({
            items: [{
                id: 'check:GDPR-x:subjects', source: 'check', code: 'GDPR-x', status: 'fail', severity: 'high', title: 'T',
                meta: { frameworks: [{ regulation: 'GDPR', ref: 'Art. 30' }], verification: 'automated', detail: '3 projects need attention.', subject_count: 3, link: null, severity: 'high', scope_id: null, subjects: [] },
                action: { type: 'open_fix', label_key: 'compliance.attn_open_fix', target: '/app/admin/compliance/gdpr/GDPR-x' },
            }],
            total: 12,
            complete: true,
        });
        expect(list.total).toBe(12);
        expect(list.items[0]).toMatchObject({
            section: null,
            meta: { frameworks: [{ regulation: 'GDPR', ref: 'Art. 30' }], detail: '3 projects need attention.', subject_count: 3, severity: 'high', link: null },
            action: { type: 'open_fix', target: '/app/admin/compliance/gdpr/GDPR-x', label_key: 'compliance.attn_open_fix', count: null },
        });
        expect(list.items[0]?.meta).not.toHaveProperty('subjects');
    });

    it.each(JUNK.map((j) => [j]))('survives %p', (junk) => {
        expect(readAttentionList(junk)).toEqual({ items: [], total: null, complete: true });
    });
});

describe('readDeadlineList', () => {
    const list = readDeadlineList({
        items: [
            { id: 'dsr:12', kind: 'dsr', ref: 'DSR-12', title: 'Access', meta: { article: 'Art. 12(3)' }, started_at: '2026-09-01T00:00:00Z', due_at: '2026-10-01T00:00:00Z', state: 'soon', pct: 0.8, target: '/app/admin/compliance/dsr/12' },
            { id: 'x:1', kind: 'attestation_expiry', state: 'ok', target: '/app/admin/compliance/frameworks?tab=per_automation' },
            { id: 'x:2', kind: 'other', state: 'ok', target: { section: 'incidents', id: 'i9' } },
            'junk',
        ],
        empty_kinds: ['incident', 3],
        complete: false,
    });

    it('parses the string target into a section and an id, keeping the raw path', () => {
        expect(list.items).toHaveLength(3);
        expect(list.items[0]).toMatchObject({ pct: 0.8, started_at: '2026-09-01T00:00:00Z', target: { section: 'dsr', id: '12' }, target_path: '/app/admin/compliance/dsr/12' });
    });

    it('resolves a moved tab and accepts the object shape', () => {
        expect(list.items[1]?.target).toMatchObject({ section: 'aia', id: null, tab: 'systems' });
        expect(list.items[2]).toMatchObject({ target: { section: 'incidents', id: 'i9' }, target_path: null });
    });

    it('reads the empty kinds and the completeness', () => {
        expect(list.empty_kinds).toEqual(['incident']);
        expect(list.complete).toBe(false);
    });

    it.each(JUNK.map((j) => [j]))('survives %p', (junk) => {
        expect(readDeadlineList(junk)).toEqual({ items: [], empty_kinds: [], complete: true });
    });
});

describe('readCheckRows and the trail', () => {
    it('reads the finding state, the frameworks and the project names', () => {
        const [row] = readCheckRows([{
            check_id: 'GDPR-a', regulation: 'GDPR', framework_id: 'gdpr', weight: 3, remediationLink: 'admin/settings',
            frameworks: [{ regulation: 'GDPR', ref: 'Art. 5', framework_id: 'gdpr', in_force_since: null }],
            finding_state: { state: 'accepted', reason: 'Known', until: null, actor_id: 'u1', active: true },
            project_names: { p1: 'Alpha', p2: 7 },
        }]);
        expect(row).toMatchObject({ weight: 3, remediationLink: 'admin/settings', framework_code: null, frameworks: [{ regulation: 'GDPR', ref: 'Art. 5', framework_id: 'gdpr' }], finding_state: { state: 'accepted', reason: 'Known', until: null, active: true }, project_names: { p1: 'Alpha' } });
        expect(row?.finding_state).not.toHaveProperty('actor_id');
        expect(readCheckRows([{ check_id: 'CUSTOM-x', framework_code: 'ACME' }])[0]).toMatchObject({ framework_code: 'ACME', finding_state: null, project_names: null });
    });

    it('reads the scope of a history row and the subject of an evidence row', () => {
        expect(readCheckHistoryRows([{ status: 'fail', scope_id: 'p1' }])[0]).toMatchObject({ status: 'fail', scope_id: 'p1' });
        expect(readEvidenceRows([{ id: 7, check_id: 'GDPR-a', hash: 'h', seq: '3', subject_type: 'project', subject_id: 'p1', payload_hash: 'ph', captured_at: 'c', payload: { a: 1 } }])[0]).toEqual({
            id: '7', check_id: 'GDPR-a', hash: 'h', seq: 3, subject_type: 'project', subject_id: 'p1', payload_hash: 'ph', captured_at: 'c', payload: { a: 1 },
        });
    });

    it('reads the auto-fix summary and the run result', () => {
        expect(readAutoFixResult({ ok: true, result: { summary: 'Retention set to 30 days.' } })).toEqual({ ok: true, summary: 'Retention set to 30 days.' });
        expect(readAutoFixResult({ ok: true, result: null })).toEqual({ ok: true, summary: null });
        expect(readRunResult({ ran: 12, score: { score: 77 } })).toEqual({ ran: 12, score: 77 });
    });

    it.each(JUNK.map((j) => [j]))('survives %p', (junk) => {
        expect(readCheckRows(junk)).toEqual([]);
        expect(readEvidenceRows(junk)).toEqual([]);
        expect(readAutoFixResult(junk)).toEqual({ ok: false, summary: null });
    });
});

describe('readFrameworkList', () => {
    const list = readFrameworkList({
        frameworks: [{
            id: 'aia', regulation: 'AIA', enabled: true, in_force_from: '2024-08-01', affects_key: 'k', affects: { agents: 3, junk: 'x' },
            checks_count: 14, registers: ['ropa'], calendar_count: 4, relevance_gate: true,
            lock: { feature: 'compliance_aia', required: 'pro', upgrade_url: '/u', extra: 1 },
            phases: [{ date: '2025-02-02', label_key: 'compliance.fw_aia_phase_art4_art5' }],
            sources: [{ label: 'EUR-Lex', url: 'https://eur-lex.europa.eu/x' }, { label: 'bad', url: 'javascript:alert(1)' }, { label: 'plain', url: 'http://x' }],
            legal_review: { verified_on: '2026-09-29', age_days: 8, stale: false, stale_after_days: 120, sources: 2 },
        }],
        custom: [{ id: 'custom:1', custom_id: '1', code: 'ACME', name: 'Acme', status: 'active', score: 50, checks_count: 4, attested_count: 2 }],
        catalogue: { verified_on: '2026-09-29', stale: false, stale_ids: [] },
    });

    it('reads the legal facts, keeping only https sources', () => {
        expect(list.frameworks[0]).toMatchObject({
            in_force_from: '2024-08-01', affects: { agents: 3 }, checks_count: 14, calendar_count: 4, relevance_gate: true,
            lock: { feature: 'compliance_aia', required: 'pro', current: null, upgrade_url: '/u' },
            phases: [{ date: '2025-02-02', label_key: 'compliance.fw_aia_phase_art4_art5', label: null }],
            sources: [{ label: 'EUR-Lex', url: 'https://eur-lex.europa.eu/x' }],
            legal_review: { verified_on: '2026-09-29', age_days: 8, stale: false, stale_after_days: 120 },
        });
    });

    it('reads the custom rows and the catalogue', () => {
        expect(list.custom[0]).toMatchObject({ id: 'custom:1', code: 'ACME', name: 'Acme', status: 'active', checks_count: 4, attested_count: 2 });
        expect(list.catalogue).toEqual({ verified_on: '2026-09-29', stale: false });
    });

    it.each(JUNK.map((j) => [j]))('survives %p', (junk) => {
        expect(readFrameworkList(junk)).toEqual({ frameworks: [], custom: [], catalogue: null });
    });
});

describe('readMembers', () => {
    it('reads the contact fields', () => {
        expect(readMembers([{ id: 'u1', displayName: 'Ann', email: 'a@example.test', phone: null, orgRole: 'admin', username: 'ann' }])).toEqual([
            { id: 'u1', displayName: 'Ann', email: 'a@example.test', phone: null, orgRole: 'admin' },
        ]);
        expect(readMembers('junk')).toEqual([]);
    });
});

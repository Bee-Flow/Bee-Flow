/** The contract readers: the fields the phone relies on, and what junk degrades to. */

import { readAttention, readCheckHistory, readChecks, readDeadlines, readEvidence, readFrameworks, readOrgUsers, readRunResult, readUpload } from './readers';
import { readAccessAudit, readAuditActions, readConnections, readPortability, readRopa, readSettings } from './readersPages';
import { readAttestations, readCustomFramework, readDsrTimeline, readPolicyDoc } from './readersRegisters';

describe('aggregate readers', () => {
    it('reads the attention list and its targets', () => {
        const a = readAttention({
            items: [{ id: 'check:x', source: 'check', code: 'X', status: 'fail', severity: 'high', title: 'T', meta: { frameworks: [{ regulation: 'GDPR', ref: '5' }] }, action: { type: 'open_fix', target: '/app/x' } }],
            total: 1,
            complete: false,
        });
        expect(a.items[0]).toMatchObject({ id: 'check:x', status: 'fail', meta: { frameworks: [{ regulation: 'GDPR', ref: '5' }] }, action: { target: '/app/x' } });
        expect(a.complete).toBe(false);
        expect(readAttention(null).items).toEqual([]);
    });

    it('reads the deadlines with their targets', () => {
        const d = readDeadlines({ items: [{ id: 'dsr:1', kind: 'dsr', ref: '#1', state: 'urgent', meta: { article: '12' }, target: { section: 'dsr', id: '1' } }] });
        expect(d.items[0]).toMatchObject({ state: 'urgent', meta: { article: '12' }, target: { section: 'dsr', id: '1' } });
    });

    it('reads checks, frameworks and the member directory', () => {
        expect(readChecks([{ check_id: 'A', status: 'warn', evidence: { agent_name: 'x' } }])[0]).toMatchObject({ check_id: 'A', status: 'warn', evidence: { agent_name: 'x' }, scope_id: null });
        expect(readFrameworks({ frameworks: [{ id: 'nis2', enabled: true, locked: 'ceiling' }], custom: [] }).frameworks[0]).toMatchObject({ id: 'nis2', enabled: true, locked: 'ceiling', core: false });
        expect(readOrgUsers([{ id: 'u1', displayName: 'Ann', email: 'a@x.nl' }])[0]).toEqual({ id: 'u1', displayName: 'Ann', orgRole: null });
    });

    it('reads a check trail, a run and an upload', () => {
        expect(readCheckHistory([{ status: 'pass', run_at: 'r' }])[0]).toMatchObject({ status: 'pass', run_at: 'r' });
        expect(readEvidence([{ id: 4, hash: 'h' }])[0]).toMatchObject({ id: '4', hash: 'h' });
        expect(readRunResult({ ran: 3, score: { score: 88 } })).toEqual({ ran: 3, score: 88 });
        expect(readUpload({ uploaded: true, sha256: 'abc', filename: 'f.pdf' })).toEqual({ uploaded: true, sha256: 'abc', filename: 'f.pdf' });
    });
});

describe('page readers', () => {
    it('reads the ROPA register', () => {
        const r = readRopa({ controller: { name: 'Org', dpo_name: 'Dee' }, legal_bases: ['consent'], activities: [{ activity_id: 'a', name: 'Chat' }], processors: [{ operator: 'openai', is_eu: false, scc_confirmed: true }] });
        expect(r.controller.name).toBe('Org');
        expect(r.processors[0]).toMatchObject({ operator: 'openai', is_eu: false, scc_confirmed: true });
    });

    it('reads the portability matrix and the access trail', () => {
        expect(readPortability([{ kind: 'chats', label_key: 'k', held: 4, formats: ['json'], mounted: true }])[0]).toMatchObject({ kind: 'chats', formats: ['json'], mounted: true });
        expect(readAccessAudit({ entries: [{ id: 'e1', action: 'login_failed' }], total: 1, limit: 50, offset: 0 }).entries[0]).toMatchObject({ id: 'e1', action: 'login_failed' });
        expect(readAuditActions({ actions: ['a', 3] })).toEqual(['a']);
        expect(readSettings('x')).toEqual({});
        expect(readConnections([{ id: 7, label: 'GH' }])).toEqual([{ id: '7', label: 'GH' }]);
    });

    it('reads one document, one custom framework, attestations and a DSR timeline', () => {
        expect(readPolicyDoc({ slug: 'isp', title: 'ISP', draft_body: '# x' }).draft_body).toBe('# x');
        expect(readCustomFramework({ id: 'f', name: 'N', checks: [{ id: 'c', ref: 'Q1', title: 'T', evidence_required: true }] }).checks[0]).toMatchObject({ ref: 'Q1', evidence_required: true, severity: 'medium' });
        expect(readAttestations([{ id: 1, classification: 'monitoring_only' }])[0]).toMatchObject({ id: '1', classification: 'monitoring_only' });
        expect(readDsrTimeline({ id: 1, timeline: [{ kind: 'started', at: 'x' }] })).toEqual([{ kind: 'started', at: 'x', text: null }]);
    });
});

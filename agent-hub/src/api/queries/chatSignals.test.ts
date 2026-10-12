import { describe, expect, it } from 'vitest';
import { EMBED_NOTICE_OFF, embedMarker, parseAgentGate, parseComplianceNotice } from './chatSignals';

const VERSION = '2026-10-14T09:00:00.000Z';

describe('parseAgentGate: GET /agents/:id → complianceCounting only', () => {
    it('keeps the state and the date, nothing else of the agent', () => {
        expect(parseAgentGate({ id: 'a1', name: 'Helper', complianceCounting: { state: 'on', from: '2026-10-14', orgId: 'o1' } }))
            .toEqual({ state: 'on', from: '2026-10-14' });
    });

    it('reads an older server, junk and an explicit off as off', () => {
        expect(parseAgentGate({ id: 'a1' })).toEqual({ state: 'off', from: null });
        expect(parseAgentGate({ complianceCounting: { state: 'yes' } })).toEqual({ state: 'off', from: null });
        expect(parseAgentGate({ complianceCounting: { state: 'off', from: '2026-10-14' } })).toEqual({ state: 'off', from: null });
        expect(parseAgentGate(null)).toEqual({ state: 'off', from: null });
    });
});

describe('parseComplianceNotice: GET /agents/:id/embed → complianceNotice', () => {
    const ON = { state: 'on', from: '2026-10-14', version: VERSION, signals: ['outcomes', 'kinds'], privacyNoticeUrl: 'https://www.example.org/privacy' };

    it('keeps the enum, the date, the version, known signals and an https link', () => {
        expect(parseComplianceNotice({ complianceNotice: { ...ON, signals: ['kinds', 'health', 'outcomes'], orgName: 'Acme' } })).toEqual(ON);
        expect(parseComplianceNotice({ complianceNotice: { ...ON, privacyNoticeUrl: 'http://www.example.org' } }).privacyNoticeUrl).toBeNull();
    });

    it('a state without a well-formed version is off: no marker could match it', () => {
        expect(parseComplianceNotice({ complianceNotice: { ...ON, version: '2026-10-14' } })).toEqual(EMBED_NOTICE_OFF);
        expect(parseComplianceNotice({ complianceNotice: { ...ON, state: 'nope' } })).toEqual(EMBED_NOTICE_OFF);
        expect(parseComplianceNotice({})).toEqual(EMBED_NOTICE_OFF);
    });

    it('the visitor marker exists only while something is announced', () => {
        expect(embedMarker(parseComplianceNotice({ complianceNotice: ON }))).toBe(`agent_public@${VERSION}`);
        expect(embedMarker(EMBED_NOTICE_OFF)).toBeNull();
    });
});

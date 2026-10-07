import { describe, expect, it } from 'vitest';
import { CHAT_MONITORING_OFF, type ChatMonitoringStatus, type ShieldStatus } from '../../../api/queries/shieldStatus';
import { formatNoticeDate, lineKey, markerFor, noticeFor, payloadFor } from './chatSignalsModel';

const VERSION = '2026-10-14T09:00:00.000Z';

function status(chatMonitoring: Partial<ChatMonitoringStatus>): ShieldStatus {
    return {
        enabled: true, source: 'org', action: 'redact', failMode: 'fail_closed',
        guardReachable: true, euMode: false, coworkEnabled: false,
        chatMonitoring: {
            state: 'on', from: '2026-10-14', version: VERSION,
            surfaces: ['direct', 'agent'], signals: ['outcomes'], noticeUrl: null,
            ...chatMonitoring,
        },
    };
}

describe('noticeFor: only what is counted is announced', () => {
    it('is null while chat signals are off, or the status is unknown', () => {
        expect(noticeFor({ status: { ...status({}), chatMonitoring: CHAT_MONITORING_OFF }, surface: 'direct' })).toBeNull();
        expect(noticeFor({ status: null, surface: 'direct' })).toBeNull();
        expect(noticeFor({ status: status({}), surface: null })).toBeNull();
    });

    it('is null unless the status lists this chat type', () => {
        expect(noticeFor({ status: status({ surfaces: ['agent'] }), surface: 'direct' })).toBeNull();
        expect(noticeFor({ status: status({ surfaces: ['direct'] }), surface: 'direct' })).not.toBeNull();
    });

    it('the agent chat also needs the gate: the agent must belong to the caller\'s own organisation', () => {
        const s = status({});
        expect(noticeFor({ status: s, surface: 'agent' })).toBeNull();
        expect(noticeFor({ status: s, surface: 'agent', agentGate: { state: 'off', from: null } })).toBeNull();
        expect(noticeFor({ status: s, surface: 'agent', agentGate: { state: 'on', from: '2026-10-14' } })?.surface).toBe('agent');
        expect(noticeFor({ status: s, surface: 'agent', agentGate: { state: 'scheduled', from: '2026-10-14' } })).not.toBeNull();
    });

    it('carries the state, the date, the signals, the link and the opt-out', () => {
        const n = noticeFor({
            status: status({ state: 'scheduled', signals: ['outcomes', 'kinds'], noticeUrl: 'https://example.org/n' }),
            surface: 'direct',
            optedOut: true,
        });
        expect(n).toEqual({
            surface: 'direct', state: 'scheduled', from: '2026-10-14', version: VERSION,
            signals: ['outcomes', 'kinds'], noticeUrl: 'https://example.org/n',
            marker: `direct@${VERSION}`, optedOut: true,
        });
    });
});

describe('the line and the marker', () => {
    it('the line varies by state and by signal', () => {
        expect(lineKey({ state: 'on', signals: ['outcomes'] })).toBe('chat_monitoring.chat.line');
        expect(lineKey({ state: 'on', signals: ['outcomes', 'kinds'] })).toBe('chat_monitoring.chat.line_kinds');
        expect(lineKey({ state: 'scheduled', signals: ['outcomes'] })).toBe('chat_monitoring.chat.scheduled');
        expect(lineKey({ state: 'scheduled', signals: ['outcomes', 'kinds'] })).toBe('chat_monitoring.chat.scheduled_kinds');
    });

    it('the marker is the chat type and the exact version, in the server\'s format', () => {
        const marker = markerFor('direct', VERSION);
        expect(marker).toBe('direct@2026-10-14T09:00:00.000Z');
        expect(marker).toMatch(/^(direct|agent|agent_public)@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it('the payload is the marker, plus the opt-out only when chosen', () => {
        const n = noticeFor({ status: status({}), surface: 'direct' });
        expect(n && payloadFor(n)).toEqual({ chatSignalsNotice: `direct@${VERSION}` });
        const out = noticeFor({ status: status({}), surface: 'direct', optedOut: true });
        expect(out && payloadFor(out)).toEqual({ chatSignalsNotice: `direct@${VERSION}`, chatSignalsOptOut: true });
    });

    it('prints the start date as a UTC day', () => {
        expect(formatNoticeDate('2026-10-14')).toBe('14 October 2026');
        expect(formatNoticeDate('14-10-2026')).toBe('');
        expect(formatNoticeDate(null)).toBe('');
    });
});

import { describe, expect, it } from 'vitest';
import { CHAT_MONITORING_OFF, httpsUrlOrNull, parseChatMonitoring, parseShieldStatus } from './shieldStatus';

/**
 * The chat-signals block of /api/privacy/shield-status. It decides whether
 * the composer announces counting and which marker a turn carries, so the
 * parser lets through only the enum, a date, the exact version timestamp,
 * known ids and an https link; everything else reads as off.
 */

const VERSION = '2026-10-14T09:00:00.000Z';
const ON = {
    state: 'on', from: '2026-10-14', version: VERSION,
    surfaces: ['direct', 'agent'], signals: ['outcomes', 'kinds'],
    noticeUrl: 'https://intranet.example.org/chat-signals',
};

describe('parseChatMonitoring: the allow-list', () => {
    it('keeps the enum, the date, the version, known ids and an https notice', () => {
        expect(parseChatMonitoring(ON)).toEqual(ON);
    });

    it('drops every key it does not know, and unknown ids inside the lists', () => {
        const parsed = parseChatMonitoring({
            ...ON,
            surfaces: ['direct', 'notebook', 'project_chat', 'direct', 7],
            signals: ['kinds', 'special_kinds', 'outcomes'],
            orgId: 'org-1', userId: 'u-1', enabledBy: 'Ada',
        });
        expect(parsed).toEqual({ ...ON, surfaces: ['direct'], signals: ['outcomes', 'kinds'] });
        expect(Object.keys(parsed).sort()).toEqual(['from', 'noticeUrl', 'signals', 'state', 'surfaces', 'version']);
    });

    it('keeps a notice link only when it is https', () => {
        expect(parseChatMonitoring({ ...ON, noticeUrl: 'http://intranet.example.org/n' }).noticeUrl).toBeNull();
        expect(parseChatMonitoring({ ...ON, noticeUrl: 'javascript:alert(1)' }).noticeUrl).toBeNull();
        expect(parseChatMonitoring({ ...ON, noticeUrl: '/relative' }).noticeUrl).toBeNull();
        expect(httpsUrlOrNull(`https://example.org/${'a'.repeat(600)}`)).toBeNull();
    });

    it('drops a start date in another shape', () => {
        expect(parseChatMonitoring({ ...ON, from: '14-10-2026' }).from).toBeNull();
    });
});

describe('parseChatMonitoring: junk reads as off', () => {
    it('reads an unknown state, a missing body and a non-object as off', () => {
        expect(parseChatMonitoring({ ...ON, state: 'enabled' })).toEqual(CHAT_MONITORING_OFF);
        expect(parseChatMonitoring(undefined)).toEqual(CHAT_MONITORING_OFF);
        expect(parseChatMonitoring('on')).toEqual(CHAT_MONITORING_OFF);
        expect(parseChatMonitoring([ON])).toEqual(CHAT_MONITORING_OFF);
    });

    it('reads a state without a well-formed version as off: no version, no marker, no notice', () => {
        expect(parseChatMonitoring({ ...ON, version: null })).toEqual(CHAT_MONITORING_OFF);
        expect(parseChatMonitoring({ ...ON, version: '2026-10-14' })).toEqual(CHAT_MONITORING_OFF);
        expect(parseChatMonitoring({ ...ON, version: '2026-10-14T09:00:00Z' })).toEqual(CHAT_MONITORING_OFF);
    });

    it('reads "scheduled" without a start date as off: the notice could not say when', () => {
        expect(parseChatMonitoring({ ...ON, state: 'scheduled', from: null })).toEqual(CHAT_MONITORING_OFF);
        expect(parseChatMonitoring({ ...ON, state: 'scheduled' }).state).toBe('scheduled');
    });

    it('an explicit off carries nothing, whatever else the body says', () => {
        expect(parseChatMonitoring({ ...ON, state: 'off' })).toEqual(CHAT_MONITORING_OFF);
    });
});

describe('parseShieldStatus: the chat-signals block rides along', () => {
    const SHIELD = {
        enabled: true, source: 'org', action: 'redact', failMode: 'fail_closed',
        guardReachable: true, euMode: false, coworkEnabled: false,
    };

    it('an older server without the field reads as off', () => {
        expect(parseShieldStatus(SHIELD)?.chatMonitoring).toEqual(CHAT_MONITORING_OFF);
    });

    it('passes the block through the same allow-list', () => {
        expect(parseShieldStatus({ ...SHIELD, chatMonitoring: { ...ON, extra: 1 } })?.chatMonitoring).toEqual(ON);
        expect(parseShieldStatus({ ...SHIELD, chatMonitoring: 'on' })?.chatMonitoring).toEqual(CHAT_MONITORING_OFF);
    });
});

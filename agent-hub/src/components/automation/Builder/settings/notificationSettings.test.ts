import { describe, expect, it } from 'vitest';
import { NOTIFICATION_SETTINGS_DEFAULTS, normalizeNotificationSettings, toggleChannel } from './notificationSettings';

describe('normalizeNotificationSettings', () => {
    it('fills an automation without settings with the quiet defaults', () => {
        const s = normalizeNotificationSettings(undefined);
        expect(s).toEqual(NOTIFICATION_SETTINGS_DEFAULTS);
        expect(s.onSuccess.enabled).toBe(false);
        expect(s.onError.channels).toEqual(['bell', 'email']);
        expect(s.onApproval.recipients).toEqual([{ type: 'approver' }]);
        expect(s.digest).toEqual({ enabled: false, time: '17:00' });
    });

    it('reads the older shape: inapp/nc_notification become the bell, nc_talk becomes Talk, level becomes urgency', () => {
        const s = normalizeNotificationSettings({
            onError: { enabled: true, level: 'urgent', channels: ['inapp', 'email'] },
            onApproval: { enabled: true, level: 'heads_up', channels: ['inapp', 'nc_talk', 'nc_notification'] },
            onSuccess: { enabled: false, level: 'ai_task', channels: ['inapp'] },
        });
        expect(s.onError).toMatchObject({ enabled: true, channels: ['bell', 'email'], urgency: 'urgent' });
        // Like the server: an old automation gets no throttle and direct delivery.
        expect(s.onError).toMatchObject({ throttle: { maxPerHour: null }, delivery: 'direct', recipients: [{ type: 'owner' }] });
        expect(s.onSuccess.delivery).toBe('direct');
        expect(s.onApproval).toMatchObject({ channels: ['bell', 'talk'], urgency: 'normal' });
        expect(s.onSuccess.enabled).toBe(false);
    });

    it('reads a partial new-shape event like the server: defaults, not the legacy rules', () => {
        // No level and no old channel name: not the old shape, so the event's
        // own defaults fill the gaps (server normalizeEventSettings).
        const s = normalizeNotificationSettings({ onSuccess: { enabled: true, channels: ['email'] } });
        expect(s.onSuccess).toEqual({
            enabled: true, channels: ['email'], recipients: [{ type: 'owner' }],
            urgency: 'silent', throttle: { maxPerHour: 1 }, delivery: 'digest',
        });
        const old = normalizeNotificationSettings({ onApproval: { enabled: true, level: 'info', ncTalkRoom: ' abc ' } });
        expect(old.onApproval).toMatchObject({ recipients: [{ type: 'approver' }], urgency: 'silent', talkRoom: 'abc' });
        expect(normalizeNotificationSettings({ onError: { throttle: { maxPerHour: 99.7 } } }).onError.throttle).toEqual({ maxPerHour: 60 });
        expect(normalizeNotificationSettings({ digest: { enabled: true, time: '25:00' } }).digest.time).toBe('17:00');
    });

    it('keeps the new shape as stored and drops unknown channels and bad recipients', () => {
        const s = normalizeNotificationSettings({
            onError: {
                enabled: true, channels: ['talk', 'slack'], urgency: 'silent', throttle: { maxPerHour: null },
                recipients: [{ type: 'group', id: 'g1' }, { type: 'group', id: 'g1' }, { type: 'user' }, { type: 'owner' }],
            },
            digest: { enabled: true, time: '08:30' },
        });
        expect(s.onError).toEqual({
            enabled: true, channels: ['talk'], urgency: 'silent', throttle: { maxPerHour: null },
            recipients: [{ type: 'group', id: 'g1' }, { type: 'owner' }], delivery: 'direct',
        });
        expect(s.onSuccess.delivery).toBe('digest');
        expect(s.digest).toEqual({ enabled: true, time: '08:30' });
    });
});

describe('toggleChannel', () => {
    it('turns the event off when its last channel goes, and on again with one channel', () => {
        const off = toggleChannel({ ...NOTIFICATION_SETTINGS_DEFAULTS.onError, channels: ['bell'] }, 'bell');
        expect(off).toMatchObject({ enabled: false, channels: [] });
        const on = toggleChannel(off, 'email');
        expect(on).toMatchObject({ enabled: true, channels: ['email'] });
    });

    it('keeps the channel order bell, email, talk', () => {
        const e = toggleChannel({ ...NOTIFICATION_SETTINGS_DEFAULTS.onError, channels: ['email'] }, 'bell');
        expect(e.channels).toEqual(['bell', 'email']);
    });
});

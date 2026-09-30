import { activeUsers, countdown, instanceHost, pairingCommands, syncFreshness } from './nextcloud';

const NOW = Date.parse('2026-09-25T12:00:00Z');

describe('Nextcloud sync words', () => {
    it('calls a sync in the last half hour fresh', () => {
        expect(syncFreshness(null, NOW)).toBe('never');
        expect(syncFreshness('2026-09-25T11:45:00Z', NOW)).toBe('fresh');
        expect(syncFreshness('2026-09-25T11:00:00Z', NOW)).toBe('stale');
    });

    it('counts active mirrored accounts and shows the host without its scheme', () => {
        expect(activeUsers([{ status: 'active' }, { status: 'pending' }, { status: 'active' }] as never)).toBe(2);
        expect(instanceHost({ ncBaseUrl: 'https://cloud.example.nl' })).toBe('cloud.example.nl');
        expect(instanceHost({ ncBaseUrl: null } as never)).toBe('—');
    });

    it('counts a pairing code down, and says when it has run out', () => {
        expect(countdown('2026-09-25T12:12:05Z', NOW)).toBe('12m 05s');
        expect(countdown('2026-09-25T11:59:59Z', NOW)).toBeNull();
        expect(countdown(null, NOW)).toBe('');
    });

    it('writes the three occ commands with the code in them', () => {
        expect(pairingCommands('ABC-123').split('\n')).toEqual([
            'occ app_api:app:setenv bee_flow BEEFLOW_PAIRING_CODE ABC-123',
            'occ app_api:app:disable bee_flow',
            'occ app_api:app:enable bee_flow',
        ]);
    });
});

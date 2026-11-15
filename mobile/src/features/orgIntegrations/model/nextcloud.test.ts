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

    it('gives the code as an install-time value, with a command AppAPI has', () => {
        expect(pairingCommands('ABC-123')).toBe('occ app_api:app:register bee_flow <daemon> --env BEEFLOW_PAIRING_CODE=ABC-123');
        // AppAPI has no command that changes a value of an installed app.
        expect(pairingCommands('ABC-123')).not.toContain(['app_api:app:', 'setenv'].join(''));
    });
});

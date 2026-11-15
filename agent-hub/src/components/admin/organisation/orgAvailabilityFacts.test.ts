import { describe, expect, it } from 'vitest';
import { availabilityAnswer } from '@/test/organisationHubKit';
import { orgAvailabilityFactsOf } from './orgAvailabilityFacts';

describe('orgAvailabilityFactsOf: the chosen organisation, not the viewer\'s session', () => {
    const read = (over = {}) => ({ data: availabilityAnswer(over) });
    const base = { platformAdmin: false, homeOrg: true, sessionNcBound: false };

    it('Microsoft 365: set up on the server, and a directory connected or the viewer\'s own organisation', () => {
        const answer = (over: { serverConfigured?: boolean; directoryConnected?: boolean; homeOrg?: boolean }) => {
            const data = availabilityAnswer({ homeOrg: over.homeOrg ?? true });
            data.families.microsoft = { ...data.families.microsoft, serverConfigured: over.serverConfigured ?? true };
            data.microsoft = { directoryConnected: !!over.directoryConnected };
            return { data };
        };
        expect(orgAvailabilityFactsOf({ ...base, read: answer({}) }).microsoft365).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, read: answer({ serverConfigured: false }) }).microsoft365).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, read: answer({ homeOrg: false }) }).microsoft365).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, read: answer({ homeOrg: false, directoryConnected: true }) }).microsoft365).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, read: undefined }).microsoft365).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: undefined }).microsoft365).toBe(true);
    });

    it('reads each family and the binding from the answer', () => {
        const facts = orgAvailabilityFactsOf({ ...base, read: read({ off: ['mcp', 'learningCenter'], ncBound: true }) });
        expect(facts).toMatchObject({ ncBound: true, ncSectionAvailable: true, mcp: false, learningCenter: false, automations: true, meetingNotes: true, projects: true });
        // A session that says otherwise is not asked once the answer is there.
        expect(orgAvailabilityFactsOf({ ...base, sessionNcBound: true, read: read() }).ncBound).toBe(false);
    });

    it('GitHub: the family, or a sync already set up for the organisation', () => {
        expect(orgAvailabilityFactsOf({ ...base, read: read({ off: ['github'] }) }).githubAvailable).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, read: read({ off: ['github'], githubSync: true }) }).githubAvailable).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, read: read() }).githubAvailable).toBe(true);
    });

    // Changed on purpose (wave 3): an organisation admin may pair their own organisation too.
    it('Nextcloud: a bound organisation, or the viewer\'s own one while pairing is offered, for a platform or organisation admin', () => {
        const unbound = read({ ncBound: false });
        const noPairing = { data: { ...availabilityAnswer({ ncBound: false }), nextcloud: { bound: false, apps: [], pairingAvailable: false } } };
        expect(orgAvailabilityFactsOf({ ...base, read: unbound }).ncSectionAvailable).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: unbound }).ncSectionAvailable).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: read({ ncBound: false, homeOrg: false }) }).ncSectionAvailable).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, orgAdmin: true, read: unbound }).ncSectionAvailable).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, orgAdmin: true, read: noPairing }).ncSectionAvailable).toBe(false);
        expect(orgAvailabilityFactsOf({ ...base, orgAdmin: true, read: read({ ncBound: false, homeOrg: false }) }).ncSectionAvailable).toBe(false);
        // Without an answer an organisation admin's row stays closed (the fail policy).
        expect(orgAvailabilityFactsOf({ ...base, orgAdmin: true, read: undefined }).ncSectionAvailable).toBe(false);
    });

    it('without an answer: a platform admin fails open, an organisation admin closed; the binding falls back to the session for the home organisation', () => {
        for (const missing of [undefined, { isError: true }, { data: undefined }]) {
            const admin = orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: missing });
            expect(admin).toMatchObject({ mcp: true, learningCenter: true, meetingNotes: true, githubAvailable: true, ncSectionAvailable: true });
            const orgAdmin = orgAvailabilityFactsOf({ ...base, read: missing });
            expect(orgAdmin).toMatchObject({ mcp: false, learningCenter: false, meetingNotes: false, githubAvailable: false, ncSectionAvailable: false });
        }
        expect(orgAvailabilityFactsOf({ ...base, sessionNcBound: true, read: undefined })).toMatchObject({ ncBound: true, ncSectionAvailable: true });
        expect(orgAvailabilityFactsOf({ ...base, homeOrg: false, sessionNcBound: true, read: undefined }).ncBound).toBe(false);
    });

    it('a degraded answer cannot vouch for the plan: unknown, by the fail policy', () => {
        const degraded = { data: { ...availabilityAnswer({ off: ['mcp'] }), degraded: true } };
        expect(orgAvailabilityFactsOf({ ...base, platformAdmin: true, read: degraded }).mcp).toBe(true);
        expect(orgAvailabilityFactsOf({ ...base, read: degraded }).mcp).toBe(false);
    });
});

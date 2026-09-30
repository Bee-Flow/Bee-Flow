import {
    readDsrRequests,
    readDsrSubmit,
    readGuardStatus,
    readOrganization,
    readOrgMembers,
    readOrgShield,
    readUserShield,
} from './readers';

describe('readUserShield', () => {
    it('validates the known fields and keeps the ones this build does not know', () => {
        // PUT /user/me replaces the stored document, so an unknown setting has
        // to travel back as it came rather than be reset by an allow-list.
        const shield = readUserShield({
            enabled: false,
            piiDetectionCategories: ['Email', 7],
            piiDetectionConfidenceThreshold: '0.5',
            futureSetting: 'keep me',
        });
        expect(shield).toMatchObject({
            enabled: false,
            piiDetectionEnabled: true,
            piiDetectionCategories: ['Email'],
            piiDetectionConfidenceThreshold: 0.5,
            piiDetectionAction: 'tokenize',
            piiFailureMode: 'fail_closed',
        });
        expect((shield as unknown as Record<string, unknown>).futureSetting).toBe('keep me');
    });

    it('is null for anything that is not a document', () => {
        expect(readUserShield(null)).toBeNull();
        expect(readUserShield([])).toBeNull();
    });
});

describe('the people readers', () => {
    it('reads members, keeping groups as a list or as the older joined string', () => {
        const [a, b] = readOrgMembers([
            { id: 'u1', email: 'a@b.nl', groups: ['g1', 2], avatar: null },
            { id: 'u2', groups: 'g1,g2', organizationId: null },
        ]);
        expect(a).toMatchObject({ id: 'u1', email: 'a@b.nl', groups: ['g1'], avatar: null });
        expect(b?.groups).toBe('g1,g2');
        expect(b?.organizationId).toBeUndefined();
        expect(readOrgMembers({ users: [] })).toEqual([]);
    });

    it('reads an organisation, and a refusal body as null', () => {
        expect(readOrganization({ id: 'o1', name: 'Acme', kvk: '123' })).toMatchObject({
            id: 'o1',
            name: 'Acme',
            kvk: '123',
        });
        expect(readOrganization(null)).toBeNull();
    });
});

describe('the compliance readers', () => {
    it('keeps an absent subject email absent, so the screen says Anonymous', () => {
        const [row] = readDsrRequests([{ id: 4, status: 'open', request_type: 'access', subject_email: null }]);
        expect(row?.subject_email).toBeUndefined();
        expect(row?.id).toBe(4);
    });

    it('reads a filed request without a reference as null, not 0', () => {
        expect(readDsrSubmit({ id: 12, created_at: 'x' })?.id).toBe(12);
        expect(readDsrSubmit({ created_at: 'x' })?.id).toBeNull();
    });
});

describe('the guard and org shield readers', () => {
    it('reads a missing guard flag as "not configured"', () => {
        expect(readGuardStatus({ reachable: true })).toEqual({ configured: false, reachable: true });
    });

    it('reads the org shield with its scope and clamps', () => {
        const shield = readOrgShield({ enabled: true, scope: { userInput: true }, clamped_fields: ['action'] });
        expect(shield?.scope).toEqual({ userInput: true, agentOutput: false });
        expect(shield?.clamped_fields).toEqual(['action']);
        expect(shield?.stalenessWarnings).toBeUndefined();
    });
});

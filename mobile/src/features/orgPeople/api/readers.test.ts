import {
    readCustomTiersList,
    readGroupAccess,
    readGroups,
    readInvitations,
    readInviteResult,
    readMembers,
    readMfaReset,
    readModels,
    readOrgCustomTiers,
    readOrgRoles,
    readProviders,
    readSavedRolePermissions,
    readSaveTiersResult,
} from './readers';

describe('people readers', () => {
    it('reads a member, splitting a legacy comma-joined groups string', () => {
        const [a, b] = readMembers([
            { id: 'u1', displayName: 'Ada', status: 'pending', groups: ['g1'], mfaEnabled: true, lastSeenAt: '2026-09-01', extra: 1 },
            { id: 'u2', groups: 'g1, g2', avatar: 5 },
            'not a row',
        ]);
        expect(a).toMatchObject({ id: 'u1', displayName: 'Ada', status: 'pending', groups: ['g1'], mfaEnabled: true });
        expect(b).toMatchObject({ id: 'u2', groups: ['g1', 'g2'], avatar: null, lastSeenAt: null });
        expect(readMembers({ nope: true })).toEqual([]);
    });

    it('reads groups with allowedTiers defaulting to no restriction', () => {
        expect(readGroups([{ id: 'g', name: 'Sales', orgRole: 'dpo', source: 'nextcloud' }])).toEqual([
            {
                id: 'g',
                name: 'Sales',
                description: undefined,
                organizationId: undefined,
                orgRole: 'dpo',
                allowedTiers: [],
                source: 'nextcloud',
            },
        ]);
    });

    it('reads invitation ids from a serial column as strings', () => {
        expect(readInvitations([{ id: 7, email: 'a@b.nl', inviterName: 'Ada' }])[0]).toMatchObject({ id: '7', email: 'a@b.nl' });
        expect(readInvitations([{ email: 'x' }])[0]?.id).toBe('');
        expect(readInviteResult({ success: true, emailSent: false, inviteUrl: 'https://x/redeem' })).toEqual({
            success: true,
            emailSent: false,
            inviteUrl: 'https://x/redeem',
        });
    });

    it('reads the org-role mapping and what a save stored', () => {
        expect(readOrgRoles({ roles: [{ id: 'member', permissions: ['use_apps', 3] }, { permissions: [] }], editablePermissions: ['use_apps'] })).toEqual({
            roles: [{ id: 'member', permissions: ['use_apps'] }],
            editablePermissions: ['use_apps'],
        });
        expect(readOrgRoles(null)).toEqual({ roles: [], editablePermissions: [] });
        expect(readSavedRolePermissions({ id: 'member', permissions: ['a'] })).toEqual(['a']);
        expect(readSavedRolePermissions({})).toBeNull();
        expect(readMfaReset({ success: true, wasEnabled: false })).toEqual({ wasEnabled: false });
    });
});

describe('tier readers', () => {
    it('reads the tier list, dropping id-less rows', () => {
        expect(readCustomTiersList({ tiers: [{ id: 'custom:a', label: 'A' }, { label: 'none' }] })).toEqual([
            { id: 'custom:a', label: 'A', icon: undefined, description: undefined, scope: undefined },
        ]);
    });

    it('keeps unknown tier keys so a POST of the whole list does not drop them', () => {
        const data = readOrgCustomTiers({
            orgTiers: [{ id: 'custom:a', label: 'A', reasoningEffort: 'high', maxTokens: '2048' }],
            globalTiers: [{ id: 'custom:g', label: 'G' }],
        });
        expect(data.orgTiers[0]).toMatchObject({ id: 'custom:a', reasoningEffort: 'high', maxTokens: 2048, temperature: 0.7, icon: '✨' });
        expect(data.globalTiers.map((g) => g.id)).toEqual(['custom:g']);
        expect(readSaveTiersResult({ tiers: [], warnings: ['w'] })).toEqual({ tiers: [], warnings: ['w'] });
        expect(readSaveTiersResult({ success: true })).toEqual({ tiers: null, warnings: [] });
    });

    it('reads providers and tags their models', () => {
        expect(readProviders({ providers: [{ id: 'p1', name: 'OpenAI', apiKey: '••' }, { name: 'no id' }] })).toEqual([
            { id: 'p1', name: 'OpenAI' },
        ]);
        expect(readModels({ models: [{ id: 'gpt', name: 'GPT' }, { id: 'raw' }] }, 'OpenAI')).toEqual([
            { id: 'gpt', name: 'GPT', providerName: 'OpenAI' },
            { id: 'raw', name: 'raw', providerName: 'OpenAI' },
        ]);
    });
});

describe('readGroupAccess', () => {
    it('reads the matrix payload and drops rows without an id', () => {
        const access = readGroupAccess({
            orgId: 'o1',
            mode: 'cloud',
            capabilities: [{ id: 'notes', kind: 'core', name: 'Notes' }, { kind: 'beta' }],
            ceiling: ['notes'],
            everyone: [],
            groups: [{ id: 'g1', name: 'Sales', granted: ['notes'] }, { name: 'x' }],
            betaGoverned: true,
        });
        expect(access.capabilities.map((c) => c.id)).toEqual(['notes']);
        expect(access.groups).toEqual([{ id: 'g1', name: 'Sales', granted: ['notes'] }]);
        expect(access.betaGoverned).toBe(true);
        expect(readGroupAccess('<html>')).toMatchObject({ orgId: null, capabilities: [], groups: [], betaGoverned: false });
    });
});

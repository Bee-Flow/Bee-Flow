/**
 * The entitlement and licence readers: what a partial, legacy or hostile
 * payload reads as.
 */

import { readEntitlements, readKindLists, readLicenseInfo } from './readers';

describe('readEntitlements', () => {
    it('is null without a body', () => {
        expect(readEntitlements(null)).toBeNull();
        expect(readEntitlements('<html>')).toBeNull();
    });

    it('reads the snapshot the server sends, tier normalised', () => {
        const read = readEntitlements({
            mode: 'self-hosted',
            tier: 'pro',
            superAdmin: true,
            degraded: false,
            ceiling: { core: ['automations'], beta: ['webpages'], integration: [] },
            effective: { core: ['automations'], beta: [], integration: [] },
            orgAvailable: { core: [], beta: [], integration: [] },
            reasons: { webpages: 'not_granted', bad: 3 },
            limits: { maxAgents: 5 },
            registry: [
                { id: 'automations', kind: 'core', licenseFeature: 'automations', name: 'Automations' },
                { id: 'webpages', kind: 'beta', licenseFeature: null },
                'junk',
            ],
        });
        expect(read).toEqual({
            mode: 'self-hosted',
            tier: 'enterprise',
            superAdmin: true,
            degraded: false,
            ceiling: { core: ['automations'], beta: ['webpages'], integration: [] },
            effective: { core: ['automations'], beta: [], integration: [] },
            reasons: { webpages: 'not_granted' },
            registry: [
                { id: 'automations', kind: 'core', licenseFeature: 'automations' },
                { id: 'webpages', kind: 'beta', licenseFeature: null },
                { id: '', kind: '', licenseFeature: null },
            ],
        });
    });

    it('reads an unknown mode as cloud and the degraded answer as degraded', () => {
        const read = readEntitlements({ mode: 'on-prem', degraded: true });
        expect(read).toMatchObject({ mode: 'cloud', tier: 'community', degraded: true, registry: [] });
        expect(read?.effective).toEqual({ core: [], beta: [], integration: [] });
    });
});

describe('readKindLists', () => {
    it('folds a legacy mcp bucket into integration, as the web does', () => {
        expect(readKindLists({ integration: ['nc'], mcp: ['mcp:github', 7] })).toEqual({
            core: [],
            beta: [],
            integration: ['nc', 'mcp:github'],
        });
    });
});

describe('readLicenseInfo', () => {
    it('keeps the gating part of the licence status', () => {
        expect(
            readLicenseInfo({
                tier: 'pro',
                source: 'license_key',
                features: ['webpages', null],
                serverOverride: true,
                license: { id: 'l1' },
            }),
        ).toEqual({ tier: 'enterprise', source: 'license_key', features: ['webpages'], serverOverride: true });
        expect(readLicenseInfo({})).toEqual({ tier: 'community', source: 'default', features: [], serverOverride: false });
        expect(readLicenseInfo(undefined)).toBeNull();
    });
});

/**
 * The EntitlementsContext port: both namespaces resolve to one capability,
 * and the lock reason is the web's three-way answer.
 */

import { compileEntitlements, lockReasonOf } from './entitlements';
import type { Entitlements } from './types';

/**
 * Enterprise org: `automations` switched on, `app_studio` in the plan but not
 * granted (licence feature `apps`), `webpages` outside the plan.
 */
const DATA: Entitlements = {
    mode: 'cloud',
    tier: 'enterprise',
    superAdmin: false,
    degraded: false,
    ceiling: { core: ['automations', 'app_studio'], beta: ['meeting_notes'], integration: ['mcp:github'] },
    effective: { core: ['automations'], beta: [], integration: ['mcp:github'] },
    reasons: { app_studio: 'not_granted', webpages: 'ceiling', learning_center: 'training' },
    registry: [
        { id: 'automations', kind: 'core', licenseFeature: 'automations' },
        { id: 'app_studio', kind: 'core', licenseFeature: 'apps' },
        { id: 'webpages', kind: 'beta', licenseFeature: 'webpages' },
        { id: 'app_studio_v2', kind: 'core', licenseFeature: 'apps' },
        { id: '', kind: 'core', licenseFeature: 'ghost' },
    ],
};

const compiled = compileEntitlements(DATA);

describe('compileEntitlements', () => {
    it('answers for every bucket, integrations included', () => {
        expect(compiled.has('automations')).toBe(true);
        expect(compiled.has('mcp:github')).toBe(true);
        expect(compiled.has('app_studio')).toBe(false);
        expect(compiled.inCeiling('app_studio')).toBe(true);
        expect(compiled.inCeiling('meeting_notes')).toBe(true);
        expect(compiled.inCeiling('webpages')).toBe(false);
    });

    it('accepts a licence-feature name for its capability; the first claim wins', () => {
        expect(compiled.resolveId('apps')).toBe('app_studio');
        expect(compiled.inCeiling('apps')).toBe(true);
        expect(compiled.resolveId('unknown')).toBe('unknown');
        // A registry row without an id maps nothing.
        expect(compiled.resolveId('ghost')).toBe('ghost');
    });
});

describe('lockReasonOf', () => {
    it('is null for what is effective', () => {
        expect(lockReasonOf(compiled, 'automations')).toBeNull();
    });

    it("is 'not_granted' for what the plan has and the org has not switched on", () => {
        expect(lockReasonOf(compiled, 'app_studio')).toBe('not_granted');
        expect(lockReasonOf(compiled, 'apps')).toBe('not_granted');
    });

    it("is the server's own reason outside the ceiling, else 'ceiling'", () => {
        expect(lockReasonOf(compiled, 'learning_center')).toBe('training');
        expect(lockReasonOf(compiled, 'webpages')).toBe('ceiling');
        expect(lockReasonOf(compiled, 'never_heard_of_it')).toBe('ceiling');
    });
});

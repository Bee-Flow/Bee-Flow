/** The drawer's conditional rows are offered on the web Sidebar's terms. */

import { buildAccessSnapshot, type AccessSnapshot } from '@/core/access';
import { compileEntitlements } from '@/core/access/model/entitlements';
import type { FeatureFlags, User } from '@/core/auth/types';

import { offersApps, offersForms, offersNotebooks, offersProjects, offersRecord } from './gates';

function who(
    permissions: string[],
    over: { user?: Partial<User>; flags?: FeatureFlags; effective?: string[]; meetingNotes?: boolean } = {},
): AccessSnapshot {
    return buildAccessSnapshot({
        user: { id: 'u', displayName: 'U', isAdmin: false, role: 'user', provider: 'local', featureFlags: over.flags, ...over.user },
        permissions: {
            permissions,
            groups: [],
            organizations: [],
            allowedAgentTypes: [],
            canUseFeature: { automations: true, meeting_notes: over.meetingNotes ?? true },
        },
        entitlements: {
            state: 'ready',
            data: compileEntitlements({
                mode: 'cloud',
                tier: 'enterprise',
                superAdmin: false,
                degraded: false,
                ceiling: { core: over.effective ?? ['app_studio', 'automations', 'notebooks', 'projects'], beta: [], integration: [] },
                effective: { core: over.effective ?? ['app_studio', 'automations', 'notebooks', 'projects'], beta: [], integration: [] },
                reasons: {},
                registry: [],
            }),
        },
    });
}

describe('the drawer’s conditional rows', () => {
    it('Record: the Meeting Notes licence and programme, and use_meeting_notes', () => {
        const licensed = ['meeting_notes'];
        expect(offersRecord(who(['use_meeting_notes'], { effective: licensed }))).toBe(true);
        expect(offersRecord(who(['use_meeting_notes'], { effective: [] }))).toBe(false);
        expect(offersRecord(who(['use_meeting_notes'], { effective: licensed, meetingNotes: false }))).toBe(false);
        expect(offersRecord(who([], { effective: licensed }))).toBe(false);
    });

    it('Apps: the app_studio capability and use_apps', () => {
        expect(offersApps(who(['use_apps']))).toBe(true);
        expect(offersApps(who([]))).toBe(false);
        expect(offersApps(who(['use_apps'], { effective: [] }))).toBe(false);
    });

    it('Forms: the automations licence and programme, and use_forms', () => {
        expect(offersForms(who(['use_forms']))).toBe(true);
        expect(offersForms(who(['use_forms'], { effective: [] }))).toBe(false);
        expect(offersForms(who([]))).toBe(false);
    });

    it('Notebooks: licence, both switches, use_notebooks, and not Simple Mode', () => {
        expect(offersNotebooks(who(['use_notebooks']))).toBe(true);
        expect(offersNotebooks(who(['use_notebooks'], { flags: { notebooksMenu: false } }))).toBe(false);
        expect(offersNotebooks(who(['use_notebooks'], { flags: { notebooks: false } }))).toBe(false);
        expect(offersNotebooks(who(['use_notebooks'], { user: { simpleMode: true } }))).toBe(false);
        expect(offersNotebooks(who([]))).toBe(false);
    });

    it('Projects: licence and switch, and not Simple Mode', () => {
        expect(offersProjects(who([]))).toBe(true);
        expect(offersProjects(who([], { flags: { projects: false } }))).toBe(false);
        expect(offersProjects(who([], { user: { simpleMode: true } }))).toBe(false);
    });
});

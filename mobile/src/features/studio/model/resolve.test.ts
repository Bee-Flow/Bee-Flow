/**
 * The Studio gate resolution: who gets Studio, which sections show, which
 * show locked and why — the web's resolveStudioNav / canSeeStudio on real
 * access snapshots.
 */

import { buildAccessSnapshot, type AccessSnapshot, type Entitlements, type Source } from '@/core/access';
import { compileEntitlements } from '@/core/access/model/entitlements';
import type { CompiledEntitlements } from '@/core/access/model/types';
import type { User } from '@/core/auth/types';

import { canSeeStudio, firstOpenSection, groupSections, resolveSections, studioNavSections } from './resolve';

const DATA: Entitlements = {
    mode: 'cloud',
    tier: 'enterprise',
    superAdmin: false,
    degraded: false,
    // The plan includes app_studio but the org has not switched it on; it
    // does not include meeting_notes at all.
    ceiling: { core: ['automations', 'app_studio', 'skills', 'webpages', 'projects', 'approvals'], beta: [], integration: [] },
    effective: { core: ['automations', 'skills', 'webpages', 'projects', 'approvals'], beta: [], integration: [] },
    reasons: {},
    registry: [],
};

const READY: Source<CompiledEntitlements> = { state: 'ready', data: compileEntitlements(DATA) };
const LOADING: Source<CompiledEntitlements> = { state: 'loading', data: null };

function who(
    permissions: string[],
    over: { user?: Partial<User>; entitlements?: Source<CompiledEntitlements>; canUse?: Record<string, boolean> } = {},
): AccessSnapshot {
    return buildAccessSnapshot({
        user: { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', ...over.user },
        permissions: {
            permissions,
            groups: [],
            organizations: [],
            allowedAgentTypes: [],
            canUseFeature: over.canUse ?? { automations: true, webpages: true, app_studio: true, meeting_notes: true },
        },
        entitlements: over.entitlements ?? READY,
    });
}

const BUILDER = ['manage_agents', 'manage_skills', 'manage_knowledge', 'use_automations', 'use_datatables', 'use_webpages', 'manage_apps', 'use_solutions', 'use_meeting_notes', 'use_approvals'];
const ids = (sections: { id: string }[]) => sections.map((s) => s.id);

describe('resolveSections', () => {
    it('opens what every gate allows and locks a licensed-but-off section with its reason', () => {
        const sections = resolveSections(who(BUILDER));
        const apps = sections.find((s) => s.id === 'apps');
        expect(apps?.locked).toBe('not_granted');
        const meetings = sections.find((s) => s.id === 'meetingNotes');
        expect(meetings?.locked).toBe('ceiling');
        expect(sections.find((s) => s.id === 'aiTasks')?.locked).toBeNull();
    });

    it('hides, never locks, while the entitlements are still loading', () => {
        const sections = resolveSections(who(BUILDER, { entitlements: LOADING }));
        expect(sections.some((s) => s.locked)).toBe(false);
        expect(ids(sections)).not.toContain('apps');
    });

    it('hides a section whose failing leg is a permission, even when it could lock', () => {
        // Entitled to automations, but no use_automations: a person gate hides.
        expect(ids(resolveSections(who(['manage_agents'])))).not.toContain('aiTasks');
    });

    it('asks only what each gate asks, exactly as the web does', () => {
        // No permissions at all: only Documents (no gate) opens. A section
        // whose role permission is missing is hidden even where its LICENCE
        // would lock it — an upgrade would not open it for this person either
        // (the web's resolveStudioNav skips the lock on a permission miss).
        const sections = resolveSections(who([]));
        expect(ids(sections.filter((s) => !s.locked))).toEqual(['documents']);
        expect(ids(sections.filter((s) => s.locked))).toEqual([]);
    });

    it('locks on the licence only for someone whose role opens the section', () => {
        const sections = resolveSections(who(['use_meeting_notes']));
        expect(sections.find((s) => s.id === 'meetingNotes')?.locked).toBe('ceiling');
        expect(ids(sections)).not.toContain('apps');
    });
});

describe('studioNavSections and groupSections', () => {
    it('leaves Approvals out of the Studio group (it has its own row)', () => {
        const snapshot = who(BUILDER);
        expect(ids(resolveSections(snapshot))).toContain('approvals');
        expect(ids(studioNavSections(snapshot))).not.toContain('approvals');
    });

    it('files the sections under Build, AI, Bundle in that order, keeping the registry order inside', () => {
        const groups = groupSections(studioNavSections(who(BUILDER)));
        expect(groups.map((g) => g.category.id)).toEqual(['build', 'ai', 'bundle']);
        expect(ids(groups[1]?.sections ?? [])).toEqual(['agents', 'skills', 'knowledge', 'meetingNotes']);
    });

    it('lands the Studio row on the first section that is not locked', () => {
        const sections = studioNavSections(who(BUILDER));
        expect(firstOpenSection(sections)?.locked).toBeNull();
        expect(firstOpenSection([])).toBeNull();
    });
});

describe('canSeeStudio', () => {
    it('is for builders and admins', () => {
        const member = who(['use_apps']);
        expect(canSeeStudio(member, studioNavSections(member))).toBe(false);
        for (const snapshot of [
            who(['manage_agents']),
            who(['manage_skills']),
            who(['all']),
            who([], { user: { orgRole: 'org_admin' } }),
            who([], { user: { isAdmin: true, role: 'admin' } }),
        ]) {
            expect(canSeeStudio(snapshot, studioNavSections(snapshot))).toBe(true);
        }
    });

    it('is off in Simple Mode, whatever the role', () => {
        const simple = who(BUILDER, { user: { simpleMode: true } });
        expect(canSeeStudio(simple, studioNavSections(simple))).toBe(false);
    });

    it('is off when there is nothing in Studio to open', () => {
        expect(canSeeStudio(who(['manage_agents']), [])).toBe(false);
    });
});

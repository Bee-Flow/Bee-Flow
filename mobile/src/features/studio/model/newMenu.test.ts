/** The New menu is derived from the registry: one item per create, under its heading. */

import { buildAccessSnapshot } from '@/core/access';
import { compileEntitlements } from '@/core/access/model/entitlements';

import { buildNewMenu } from './newMenu';
import { studioNavSections } from './resolve';

const snapshot = buildAccessSnapshot({
    user: { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local' },
    permissions: {
        permissions: ['all'],
        groups: [],
        organizations: [],
        allowedAgentTypes: [],
    },
    entitlements: {
        state: 'ready',
        data: compileEntitlements({
            mode: 'cloud',
            tier: 'enterprise',
            superAdmin: false,
            degraded: false,
            ceiling: { core: ['automations', 'app_studio', 'skills', 'webpages', 'projects', 'meeting_notes'], beta: [], integration: [] },
            effective: { core: ['automations', 'skills', 'webpages', 'projects', 'meeting_notes'], beta: [], integration: [] },
            reasons: {},
            registry: [],
        }),
    },
});

describe('buildNewMenu', () => {
    const menu = buildNewMenu(studioNavSections(snapshot));

    it('puts the AI row first, then the headings in order', () => {
        // The row opens the building-block picker (the host's onDescribe), not an address.
        expect(menu[0]).toEqual({ type: 'ai', id: 'ai', labelKey: 'studio.new.ai', labelFallback: 'Describe it — AI picks the building blocks' });
        expect(menu.filter((e) => e.type === 'heading').map((e) => e.id)).toEqual([
            'heading-build',
            'heading-ai',
            'heading-bundle',
        ]);
    });

    it('lists every section with a create entry and no other', () => {
        const items = menu.filter((e) => e.type === 'item').map((e) => e.id);
        expect(items).toContain('aiTasks');
        expect(items).toContain('meetingNotes');
        // Runs has nothing to create; Approvals is not in the Studio group.
        expect(items).not.toContain('runs');
        expect(items).not.toContain('approvals');
    });

    it('keeps a locked kind listed, locked, with its reason', () => {
        const apps = menu.find((e) => e.type === 'item' && e.id === 'apps');
        expect(apps && apps.type === 'item' ? apps.locked : undefined).toBe('not_granted');
    });

    it('sends each kind to the list that hosts its create flow, opened where it can be', () => {
        const target = (id: string) => {
            const entry = menu.find((e) => e.type === 'item' && e.id === id);
            return entry && entry.type === 'item' ? entry.target : null;
        };
        expect(target('skills')).toEqual({ kind: 'route', href: '/skills?new=1' });
        expect(target('meetingNotes')).toEqual({ kind: 'route', href: '/record' });
        expect(target('datatables')).toEqual({ kind: 'route', href: '/datatables?new=1' });
        expect(target('solutions')).toEqual({ kind: 'route', href: '/projects?create=1' });
    });
});

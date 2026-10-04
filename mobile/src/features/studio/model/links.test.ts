/** Where a Studio address opens: a native screen, or the hub. */

import { attentionTarget, plainTarget, sectionForKind, sectionTarget, studioLinkTarget } from './links';
import { studioSection } from './registry';

describe('studioLinkTarget', () => {
    it('opens the hub for Studio itself', () => {
        expect(studioLinkTarget('/app/studio')).toEqual({ kind: 'route', href: '/studio' });
        expect(studioLinkTarget('/app/studio/start')).toEqual({ kind: 'route', href: '/studio' });
    });

    it('opens a native list, or one object on its detail screen', () => {
        expect(studioLinkTarget('/app/studio/apps')).toEqual({ kind: 'route', href: '/studio/apps' });
        expect(studioLinkTarget('/app/studio/apps/a1')).toEqual({ kind: 'route', href: '/apps/a1?draft=1' });
        expect(studioLinkTarget('/app/studio/meeting-notes/m1')).toEqual({ kind: 'route', href: '/recordings/m1' });
        expect(studioLinkTarget('/app/studio/solutions/p1?tab=graph')).toEqual({ kind: 'route', href: '/projects/p1' });
    });

    it('keeps the id encoded once, whatever the writer did', () => {
        expect(studioLinkTarget('/app/studio/skills/a%20b')).toEqual({ kind: 'route', href: '/skills/a%20b' });
    });

    it('opens a form’s page by its automation’s id, as the web does (forms)', () => {
        expect(studioLinkTarget('/app/studio/forms/automation1')).toEqual({ kind: 'route', href: '/forms/automation1' });
        expect(studioLinkTarget('/app/studio/forms')).toEqual({ kind: 'route', href: '/forms' });
    });

    it('opens the sections that used to be web-only on their native screens', () => {
        expect(studioLinkTarget('/app/studio/datatables')).toEqual({ kind: 'route', href: '/datatables' });
        expect(studioLinkTarget('/app/studio/datatables/t1')).toEqual({ kind: 'route', href: '/datatables/t1' });
        expect(studioLinkTarget('/app/studio/documents/d1')).toEqual({ kind: 'route', href: '/documents/d1' });
        expect(studioLinkTarget('/app/studio/runs')).toEqual({ kind: 'route', href: '/runs' });
        expect(studioLinkTarget('/app/studio/datatables/new')).toEqual({ kind: 'route', href: '/datatables?new=1' });
        // No create flow: the list, never a detail screen for an object called "new".
        expect(studioLinkTarget('/app/studio/approvals/new')).toEqual({ kind: 'route', href: '/approvals' });
    });

    it('accepts the legacy segments and ids', () => {
        expect(studioLinkTarget('/app/studio/automations/a1')).toEqual({ kind: 'route', href: '/automations/a1' });
        expect(studioLinkTarget('/app/studio/aiTasks')).toEqual({ kind: 'route', href: '/automations' });
    });

    it('refuses anything that is not a Studio section', () => {
        expect(studioLinkTarget(null)).toBeNull();
        expect(studioLinkTarget('/app/cowork/x')).toBeNull();
        expect(studioLinkTarget('/app/studio/nope/x')).toBeNull();
        expect(studioLinkTarget('/app/studio/apps/a1/extra')).toBeNull();
    });
});

describe('sectionTarget / plainTarget / sectionForKind', () => {
    it('opens a section, or one object in it', () => {
        expect(sectionTarget(studioSection('knowledge'))).toEqual({ kind: 'route', href: '/knowledge' });
        expect(sectionTarget(studioSection('knowledge'), 'kb 1')).toEqual({ kind: 'route', href: '/knowledge/kb%201' });
        expect(sectionTarget(studioSection('playbooks'), 'p1')).toEqual({ kind: 'route', href: '/playbooks/p1' });
    });

    it('opens the hub, never a browser tab, for a section only the web has', () => {
        const webOnly = { segment: 'crm', target: { kind: 'web', path: '/app/studio/crm' } } as const;
        expect(sectionTarget(webOnly)).toEqual({ kind: 'route', href: '/studio' });
        expect(sectionTarget(webOnly, 'c1')).toEqual({ kind: 'route', href: '/studio' });
        expect(plainTarget(webOnly.target)).toEqual({ kind: 'route', href: '/studio' });
    });

    it('reads a create target as it stands', () => {
        const create = studioSection('datatables').create;
        expect(create && plainTarget(create.target)).toEqual({ kind: 'route', href: '/datatables?new=1' });
    });

    it('finds the section that IS a kind — the first one that carries it', () => {
        expect(sectionForKind('kb')?.id).toBe('knowledge');
        expect(sectionForKind('automation')?.id).toBe('aiTasks');
        expect(sectionForKind('nope')).toBeNull();
        expect(sectionForKind(null)).toBeNull();
    });
});

describe('attentionTarget', () => {
    it("follows the server's deep link first, then the kind and id, else nowhere", () => {
        expect(attentionTarget({ deepLink: '/app/studio/automations/a1', kind: 'kb', targetId: 'k1' })).toEqual({
            kind: 'route',
            href: '/automations/a1',
        });
        expect(attentionTarget({ deepLink: null, kind: 'kb', targetId: 'k1' })).toEqual({ kind: 'route', href: '/knowledge/k1' });
        expect(attentionTarget({ deepLink: null, kind: 'kb', targetId: null })).toBeNull();
        expect(attentionTarget({ deepLink: null, kind: null, targetId: 'x' })).toBeNull();
    });
});

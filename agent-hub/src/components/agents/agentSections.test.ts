import { describe, it, expect } from 'vitest';
import { resolveAgentSection } from './agentSections';
import { adminSectionScope } from '../admin/dashboard/adminTabs';

describe('resolveAgentSection', () => {
    it('opens the requested section when visible', () => {
        expect(resolveAgentSection({ isAdmin: true }, 'system').active).toBe('system');
    });

    it('a platform admin limited to system agents by type still gets only that section', () => {
        const r = resolveAgentSection({ role: 'admin', allowedAgentTypes: ['system'] }, '');
        expect(r).toEqual({ visible: ['chat', 'system'], active: 'chat' });
    });

    it('system agents are for the platform admin: an organisation admin gets chat only, and a link to system lands on chat', () => {
        const orgAdmin = { permissions: ['admin_agents_system'] };
        expect(resolveAgentSection(orgAdmin, 'system')).toEqual({ visible: ['chat'], active: 'chat' });
        expect(resolveAgentSection({ permissions: ['all'] }, 'system')).toEqual({ visible: ['chat'], active: 'chat' });
    });

    it('shows nothing when the type restriction leaves only a server-wide section', () => {
        expect(resolveAgentSection({ allowedAgentTypes: ['system'] }, '')).toEqual({ visible: [], active: '' });
    });

    it('the scope of the open section follows what is rendered: system is server-wide, chat is not', () => {
        const scopeOf = (user: Parameters<typeof resolveAgentSection>[0], requested = '') => adminSectionScope('agents', resolveAgentSection(user, requested).active);
        expect(scopeOf({ isAdmin: true }, 'system')).toBe('instance');
        expect(scopeOf({ isAdmin: true })).toBe('mixed');
    });
});

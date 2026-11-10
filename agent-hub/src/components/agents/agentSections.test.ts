import { describe, it, expect } from 'vitest';
import { resolveAgentSection } from './agentSections';
import { adminSectionScope } from '../admin/dashboard/adminTabs';

describe('resolveAgentSection', () => {
    it('opens the requested section when visible', () => {
        expect(resolveAgentSection({ isAdmin: true }, 'system').active).toBe('system');
    });

    it('a viewer limited to system agents gets the system section on the bare URL', () => {
        const r = resolveAgentSection({ allowedAgentTypes: ['system'] }, '');
        expect(r).toEqual({ visible: ['system'], active: 'system' });
    });

    it('the scope of the open section follows what is rendered: system is server-wide, chat is not', () => {
        const scopeOf = (user: Parameters<typeof resolveAgentSection>[0]) => adminSectionScope('agents', resolveAgentSection(user, '').active);
        expect(scopeOf({ allowedAgentTypes: ['system'] })).toBe('instance');
        expect(scopeOf({ isAdmin: true })).toBe('mixed');
    });
});

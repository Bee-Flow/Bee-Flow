import { describe, expect, it } from 'vitest';
import { resolveSupportPath, supportPath } from './supportPath';

describe('resolveSupportPath', () => {
    it('opens the inbox on a bare address, and a ticket by its own address', () => {
        expect(resolveSupportPath()).toEqual({ view: 'inbox', threadId: null, section: 'agent' });
        expect(resolveSupportPath('inbox', 'th1')).toEqual({ view: 'inbox', threadId: 'th1', section: 'agent' });
    });

    it('opens a ticket from the server-written link admin/support/<threadId>', () => {
        expect(resolveSupportPath('th1')).toEqual({ view: 'inbox', threadId: 'th1', section: 'agent' });
    });

    it('opens a settings section, the agent when none or an unknown one is named', () => {
        expect(resolveSupportPath('settings', 'tags').section).toBe('tags');
        expect(resolveSupportPath('settings')).toEqual({ view: 'settings', threadId: null, section: 'agent' });
        expect(resolveSupportPath('settings', 'nope').section).toBe('agent');
    });

    it('opens the old view names where they live now', () => {
        expect(resolveSupportPath('ai-config')).toEqual({ view: 'settings', threadId: null, section: 'agent' });
        expect(resolveSupportPath('connections')).toEqual({ view: 'settings', threadId: null, section: 'connections' });
    });

    it('opens the insights report', () => {
        expect(resolveSupportPath('insights').view).toBe('insights');
    });
});

describe('supportPath', () => {
    it('builds the address of a view and of an item in it', () => {
        expect(supportPath('inbox')).toBe('admin/support/inbox');
        expect(supportPath('inbox', 'th 1')).toBe('admin/support/inbox/th%201');
        expect(supportPath('settings', 'sla')).toBe('admin/support/settings/sla');
    });
});

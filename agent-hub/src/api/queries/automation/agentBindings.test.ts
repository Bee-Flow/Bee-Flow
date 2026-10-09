import { describe, expect, it } from 'vitest';
import { parseAgentBindings } from './agentBindings';

describe('parseAgentBindings', () => {
    it('never lets an agent the viewer cannot edit carry a name or an id, whatever the server sent', () => {
        const out = parseAgentBindings({
            bindings: [{ agentId: 'secret', name: 'Secret', canEdit: false, missing: false, usable: true, notGranted: true }],
            canManage: true, isAgentCall: true,
        });
        expect(out.bindings).toEqual([{ agentId: null, name: null, canEdit: false, missing: false, usable: true, notGranted: true }]);
    });

    it('reads a linked, an unusable and a deleted agent', () => {
        const out = parseAgentBindings({
            bindings: [
                { agentId: 'a1', name: 'Invoice', canEdit: true, usable: true },
                { agentId: 'a2', name: 'Draft', canEdit: true, usable: false },
                { agentId: 'a3', name: null, canEdit: true, missing: true, usable: false },
            ],
            candidates: [{ id: 'a9', name: 'Other', description: 'd' }, { name: 'no id' }],
            canManage: true, isAgentCall: true, toolName: 'send_invoice', kept: 2,
        });
        expect(out.bindings.map((b) => [b.agentId, b.name, b.usable, b.missing])).toEqual([
            ['a1', 'Invoice', true, false], ['a2', 'Draft', false, false], ['a3', null, false, true],
        ]);
        expect(out.candidates).toEqual([{ id: 'a9', name: 'Other', description: 'd' }]);
        expect(out.toolName).toBe('send_invoice');
        expect(out.kept).toBe(2);
    });

    it('reads notGranted as a flag, and absent as unknown rather than granted', () => {
        const out = parseAgentBindings({
            bindings: [
                { agentId: 'a1', name: 'A', canEdit: true, usable: true, notGranted: true },
                { agentId: 'a2', name: 'B', canEdit: true, usable: true, notGranted: false },
                { agentId: 'a3', name: 'C', canEdit: true, usable: true },
            ],
        });
        expect(out.bindings.map((b) => b.notGranted)).toEqual([true, false, null]);
    });

    it('keeps "could not be read" apart from "none": absent candidates stay null', () => {
        expect(parseAgentBindings({ bindings: [], candidates: [] }).candidates).toEqual([]);
        expect(parseAgentBindings({ bindings: [] }).candidates).toBeNull();
    });

    it('is tolerant of junk and reads a viewer as unable to manage', () => {
        expect(parseAgentBindings(null)).toEqual({
            bindings: [], candidates: null, canManage: false, isAgentCall: false, toolName: null, kept: 0,
        });
        expect(parseAgentBindings({ bindings: 'x', canManage: 'yes' }).canManage).toBe(false);
    });
});

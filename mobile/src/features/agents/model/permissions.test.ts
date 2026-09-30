import { canCreateAgents, canEditAgent } from './permissions';

const AGENT = { owner_id: 'u1', can_edit: true as boolean | undefined };

describe('who may change an agent', () => {
    it('needs both the server verdict and manage_agents', () => {
        expect(canEditAgent(AGENT, true)).toBe(true);
        expect(canEditAgent(AGENT, false)).toBe(false);
        expect(canEditAgent({ ...AGENT, can_edit: undefined }, true)).toBe(false);
        expect(canEditAgent({ ...AGENT, owner_id: 'system' }, true)).toBe(false);
        expect(canCreateAgents(true)).toBe(true);
        expect(canCreateAgents(false)).toBe(false);
    });
});

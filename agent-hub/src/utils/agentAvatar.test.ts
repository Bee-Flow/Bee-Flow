import { describe, it, expect } from 'vitest';
import { pickAgentAvatar } from './agentAvatar';

// Rows reach the avatar helpers from several places; some still carry `config`
// as the JSON string the database stored. Every shape below must answer the
// same as the plain `agent.avatar || agent.config?.avatar || null` read did.
describe('pickAgentAvatar', () => {
    it('prefers the top-level avatar', () => {
        expect(pickAgentAvatar({ avatar: '🦊', config: { avatar: '🐝' } })).toBe('🦊');
    });

    it('falls back to config.avatar during the migration window', () => {
        expect(pickAgentAvatar({ avatar: null, config: { avatar: '🐝' } })).toBe('🐝');
        expect(pickAgentAvatar({ avatar: '', config: { avatar: '/uploads/a.png' } })).toBe('/uploads/a.png');
    });

    it('answers null without an agent, an avatar or a config', () => {
        expect(pickAgentAvatar(null)).toBeNull();
        expect(pickAgentAvatar(undefined)).toBeNull();
        expect(pickAgentAvatar({})).toBeNull();
        expect(pickAgentAvatar({ config: null })).toBeNull();
        expect(pickAgentAvatar({ config: {} })).toBeNull();
        expect(pickAgentAvatar({ config: { avatar: '' } })).toBeNull();
    });

    it('reads nothing from a config that is still a JSON string', () => {
        expect(pickAgentAvatar({ config: '{"avatar":"🐝"}' })).toBeNull();
        expect(pickAgentAvatar({ avatar: '🦊', config: '{"avatar":"🐝"}' })).toBe('🦊');
    });
});

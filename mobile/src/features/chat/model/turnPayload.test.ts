/**
 * The direct-chat turn body. The field names are the server's contract
 * (streamTurn.js), and the history rule is agent-hub's: only a new
 * conversation carries its own history.
 */

import { directTurnPayload, type DirectTurnInput } from './turnPayload';

const INPUT: DirectTurnInput = {
    text: 'Hello',
    attachments: [],
    conversationId: null,
    settings: { modelTier: 'auto', webSearchEnabled: true, knowledgeBaseIds: [], reasoningEffort: null },
    history: [{ role: 'user', content: 'before' }],
    memoryEnabled: true,
    activeSkillIds: [],
};

describe('directTurnPayload', () => {
    it('sends history for a new conversation only', () => {
        expect(directTurnPayload(INPUT)).toMatchObject({
            message: 'Hello',
            conversationId: undefined,
            modelTier: 'auto',
            history: [{ role: 'user', content: 'before' }],
            webSearchEnabled: true,
            memoryWriteEnabled: true,
        });
        expect(directTurnPayload({ ...INPUT, conversationId: 'c1' })).toMatchObject({
            conversationId: 'c1',
            history: undefined,
        });
    });

    it('adds knowledge bases, skills and a depth only when there are any', () => {
        const bare = directTurnPayload(INPUT);
        expect(bare).not.toHaveProperty('knowledgeBaseIds');
        expect(bare).not.toHaveProperty('activeSkillIds');
        expect(bare).not.toHaveProperty('reasoningEffort');

        const full = directTurnPayload({
            ...INPUT,
            settings: { ...INPUT.settings, knowledgeBaseIds: ['kb1'], reasoningEffort: 'high' },
            activeSkillIds: ['s1'],
        });
        expect(full).toMatchObject({ knowledgeBaseIds: ['kb1'], activeSkillIds: ['s1'], reasoningEffort: 'high' });
    });

    it('dates relative expressions in the phone’s own zone', () => {
        expect(directTurnPayload(INPUT).timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });
});

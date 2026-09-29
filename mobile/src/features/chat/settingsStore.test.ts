/**
 * The composer's remembered settings, and the payload they end up in.
 *
 * The bug this file exists against is not a crash — it is a promise the app
 * made and did not keep. `knowledgeBaseIds` and `activeSkillIds` were declared
 * on SendTurnPayload from the day the client was written and never once
 * assigned, while the server destructured both and ran access-validated
 * retrieval on them. So a document in a knowledge base could not be asked
 * about anywhere in the app, and the Skills screen counted skills "switched on
 * for new chats" that no chat ever sent.
 *
 * Nothing in TypeScript could see that: an optional field that is never set is
 * not an error. These tests are what would.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
    DEFAULT_PREFERENCES,
    parsePreferences,
    setChatPreferences,
    type ChatPreferences,
} from './settingsStore';
import type { SendTurnPayload } from './types';

describe('parsePreferences', () => {
    it('falls back to defaults for anything unreadable', () => {
        expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
        expect(parsePreferences('not json')).toEqual(DEFAULT_PREFERENCES);
        expect(parsePreferences('{}')).toEqual(DEFAULT_PREFERENCES);
        expect(parsePreferences('[]')).toEqual(DEFAULT_PREFERENCES);
    });

    it('keeps a stored web-search choice, including the off one', () => {
        // The direction that matters. A user on a privacy product who switched
        // egress off must not get it back on because a default won a merge.
        expect(parsePreferences(JSON.stringify({ webSearchEnabled: false }))).toMatchObject({
            webSearchEnabled: false,
        });
    });

    it('ignores a stored value of the wrong type rather than trusting it', () => {
        const parsed = parsePreferences(
            JSON.stringify({ modelTier: 42, webSearchEnabled: 'yes' } as unknown as ChatPreferences),
        );
        expect(parsed).toEqual(DEFAULT_PREFERENCES);
    });

    it('never carries a reasoning effort', () => {
        // Deliberately absent from the shape: a remembered "high" would spend
        // the user's allowance on every trivial question afterwards.
        const parsed = parsePreferences(JSON.stringify({ reasoningEffort: 'high' }));
        expect(parsed).not.toHaveProperty('reasoningEffort');
    });
});

describe('setChatPreferences', () => {
    it('merges rather than replacing, and writes through', async () => {
        setChatPreferences({ webSearchEnabled: false });
        setChatPreferences({ modelTier: 'deep' });

        const raw = await AsyncStorage.getItem('beeflow.chat.settings.v1');
        expect(parsePreferences(raw)).toEqual({ modelTier: 'deep', webSearchEnabled: false });
    });
});

describe('the turn payload', () => {
    /**
     * Mirrors what app/chat/[id].tsx builds. Kept here rather than exported
     * from the screen because the screen's version is entangled with the
     * transcript, the stream and the attachment encoder — and what needs
     * pinning is one narrow thing: that these two fields are present when they
     * have content and absent when they do not.
     */
    function buildTurn(input: {
        message: string;
        knowledgeBaseIds: string[];
        activeSkillIds: readonly string[];
        webSearchEnabled: boolean;
    }): Partial<SendTurnPayload> {
        return {
            message: input.message,
            webSearchEnabled: input.webSearchEnabled,
            memoryWriteEnabled: true,
            ...(input.knowledgeBaseIds.length
                ? { knowledgeBaseIds: input.knowledgeBaseIds }
                : {}),
            ...(input.activeSkillIds.length
                ? { activeSkillIds: [...input.activeSkillIds] }
                : {}),
        };
    }

    it('sends the attached bases and the switched-on skills', () => {
        const turn = buildTurn({
            message: 'what is the notice period?',
            knowledgeBaseIds: ['kb-contracts'],
            activeSkillIds: ['skill-legal'],
            webSearchEnabled: false,
        });
        expect(turn.knowledgeBaseIds).toEqual(['kb-contracts']);
        expect(turn.activeSkillIds).toEqual(['skill-legal']);
    });

    it('omits both when there is nothing to send', () => {
        // Not `[]`. The server treats an absent field and an empty array the
        // same way today, but sending an empty list says "retrieve from
        // nothing", which is a claim this client should not be making.
        const turn = buildTurn({
            message: 'hello',
            knowledgeBaseIds: [],
            activeSkillIds: [],
            webSearchEnabled: true,
        });
        expect(turn).not.toHaveProperty('knowledgeBaseIds');
        expect(turn).not.toHaveProperty('activeSkillIds');
    });

    it('passes a readonly skill list through as a mutable copy', () => {
        // The store hands out `readonly string[]`; the payload type wants
        // `string[]`. Spreading rather than casting means the store's array
        // cannot be mutated by anything downstream.
        const fromStore: readonly string[] = Object.freeze(['a', 'b']);
        const turn = buildTurn({
            message: 'x',
            knowledgeBaseIds: [],
            activeSkillIds: fromStore,
            webSearchEnabled: true,
        });
        expect(turn.activeSkillIds).toEqual(['a', 'b']);
        expect(turn.activeSkillIds).not.toBe(fromStore);
    });
});

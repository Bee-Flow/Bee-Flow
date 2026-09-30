import { describe, expect, it } from 'vitest';
import { aiFinishedNote, aiNoteText, aiOutcomeOf } from './commentAi';

const t = (_key: string, fallback?: unknown) => String(fallback ?? '');

describe('aiOutcomeOf: what a post’s `ai` answer means for its thread', () => {
    it('queued shows the AI answering; busy and every refusal the author can act on is a note', () => {
        expect(aiOutcomeOf({ status: 'queued' }, true)).toBe('queued');
        expect(aiOutcomeOf({ status: 'busy' }, true)).toBe('busy');
        expect(aiOutcomeOf({ status: 'skipped', reason: 'limit' }, true)).toBe('limit');
        expect(aiOutcomeOf({ status: 'skipped', reason: 'unavailable' }, true)).toBe('unavailable');
        expect(aiOutcomeOf({ status: 'skipped', reason: 'no_model' }, true)).toBe('unavailable');
    });

    it('"the AI is off" is news only to someone who asked it', () => {
        expect(aiOutcomeOf({ status: 'skipped', reason: 'ai_off' }, true)).toBe('ai_off');
        expect(aiOutcomeOf({ status: 'skipped', reason: 'ai_off' }, false)).toBeNull();
    });

    it('a post that did not ask, or that the AI may pick up by itself later, says nothing', () => {
        for (const reason of ['not_mentioned', 'auto_pending', 'resolved', undefined]) {
            expect(aiOutcomeOf({ status: 'skipped', reason }, false)).toBeNull();
        }
        expect(aiOutcomeOf(null, true)).toBeNull();
    });
});

describe('aiFinishedNote: how a queued answer ended', () => {
    it('blocked and failed are notes; an answer is its own message', () => {
        expect(aiFinishedNote('blocked')).toBe('blocked');
        expect(aiFinishedNote('failed')).toBe('failed');
        expect(aiFinishedNote('answered')).toBeNull();
        expect(aiFinishedNote(undefined)).toBeNull();
    });

    it('every note has its own sentence', () => {
        const notes = ['busy', 'limit', 'unavailable', 'ai_off', 'blocked', 'failed'] as const;
        const texts = notes.map((n) => aiNoteText(n, t));
        expect(new Set(texts).size).toBe(notes.length);
        for (const text of texts) expect(text).toMatch(/AI/);
    });
});

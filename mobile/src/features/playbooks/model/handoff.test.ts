/**
 * The handoff's decisions: which phases the phone starts itself (never a
 * builder it cannot drive), which face the card shows, and what "Mark as
 * done" needs and sends.
 */

import { canMarkDone, handoffFace, hasEditableBrief, markDoneArtifacts, nextWords, shouldAutoStart } from './handoff';
import type { Phase, PhaseStatus } from './types';

const t = (_k: string, en: string, p: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (m, n: string) => (n in p ? String(p[n]) : m));

const p = (key: string, status: PhaseStatus, over: Partial<Phase> = {}): Phase => ({
    key, kind: null, label: null, status, attempt: 0, brief: null, artifacts: {}, summary: null, error: null, startedAt: null, finishedAt: null, requires: null, ...over,
});

describe('shouldAutoStart', () => {
    it('starts the server phases and access, never a builder', () => {
        for (const key of ['table', 'fill', 'design', 'compliance', 'access']) expect(shouldAutoStart(p(key, 'ready'))).toBe(true);
        for (const key of ['automation', 'app', 'approvals']) expect(shouldAutoStart(p(key, 'ready'))).toBe(false);
        expect(shouldAutoStart(p('table', 'running'))).toBe(false);
        expect(shouldAutoStart(null)).toBe(false);
    });
});

describe('handoffFace', () => {
    it('picks the face from the phase, and none once the film is over', () => {
        expect(handoffFace(p('table', 'failed'), false)).toBe('failed');
        expect(handoffFace(p('table', 'awaiting'), false)).toBe('awaiting');
        expect(handoffFace(p('automation', 'running'), false)).toBe('needs_input');
        expect(handoffFace(p('fill', 'running'), false)).toBeNull();
        expect(handoffFace(p('fill', 'running', { needsInput: true }), false)).toBe('needs_input');
        expect(handoffFace(p('table', 'awaiting'), true)).toBeNull();
        expect(handoffFace(null, false)).toBeNull();
    });
});

describe('mark as done', () => {
    it('needs the automation or the app, and hands it back', () => {
        expect(canMarkDone(p('automation', 'running'))).toBe(false);
        const automation = p('automation', 'running', { artifacts: { automationId: 'a1' } });
        expect(canMarkDone(automation)).toBe(true);
        expect(markDoneArtifacts(automation)).toEqual({ automationId: 'a1' });
        const app = p('x', 'running', { kind: 'app_turn', artifacts: { appId: 'p1' } });
        expect(canMarkDone(app)).toBe(true);
        expect(markDoneArtifacts(app)).toEqual({ appId: 'p1' });
        expect(canMarkDone(p('fill', 'running', { artifacts: { appId: 'p1' } }))).toBe(false);
    });
});

describe('the next phase', () => {
    it('offers a brief to edit only for a builder phase that has one', () => {
        expect(hasEditableBrief(p('app', 'ready', { brief: '# Build it' }))).toBe(true);
        expect(hasEditableBrief(p('app', 'ready', { brief: '' }))).toBe(false);
        expect(hasEditableBrief(p('fill', 'ready', { brief: 'x' }))).toBe(false);
        expect(hasEditableBrief(null)).toBe(false);
    });

    it('says what comes next when there is no brief', () => {
        expect(nextWords(p('fill', 'pending'), t)).toBe('Next: First rows — the automation runs once so the table has real rows.');
        expect(nextWords(p('x', 'pending', { kind: 'access' }), t)).toMatch(/^Next: Access — you decide/);
        expect(nextWords(p('custom', 'pending', { kind: 'other', label: 'Mine' }), t)).toBe('Next: Mine — its brief is composed when you continue.');
    });
});

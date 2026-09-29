import { describe, it, expect } from 'vitest';

import { NODE_DEFS, PALETTE_ABSENT } from './nodeDefs';
import { NODE_TYPES } from '../DiagramPane';
import { buildSearchResults } from './stepPalette';
import { approvalSummary, approvalDeadline } from './nodeSummaries';
import { extractFormState, buildPatch } from './settings/formState';

/**
 * Approvals were engine-only for a long time: the runner paused, resumed and
 * audited them correctly, but there was no way to ADD one — no palette entry,
 * no canvas component, no editor. These tests pin the surface that makes the
 * feature reachable, and the two value traps that made it easy to get wrong:
 * a deadline of 0 (a real choice: "no deadline") and a deadline that is simply
 * absent (which must NOT become 0).
 */

describe('approval — the node is reachable', () => {
    it('is no longer declared as having no canvas component', () => {
        expect(PALETTE_ABSENT.approval).toBeUndefined();
        expect(NODE_TYPES.approval).toBeTruthy();
    });

    it('names its own editor sections', () => {
        const def = NODE_DEFS.approval;
        expect(def.sectionKeys).toEqual(['config', 'waiting']);
        // The deadline must survive Simple density: an approval that silently
        // expires over a holiday is the failure this prevents.
        expect(def.simpleSections).toContain('waiting');
        expect(def.label).toBeTruthy();
        expect(def.desc).toBeTruthy();
    });

    it('is findable by the words people actually search for', () => {
        const opts = { catalog: { flags: { code: true } } };
        for (const term of ['approve', 'approval', 'sign off', 'authorise', 'human in the loop', 'reject']) {
            const hits = buildSearchResults(term, opts);
            expect(
                hits.some(r => r.payload?.kind === 'approval'),
                `searching "${term}" should surface the approval step`,
            ).toBe(true);
        }
    });
});

describe('approval — the canvas summary is the question', () => {
    it('shows the question, not the configuration', () => {
        expect(approvalSummary({ prompt: 'Send the quote to Acme?' })).toBe('Send the quote to Acme?');
    });

    it('flags a step that would reach its approver asking nothing', () => {
        for (const prompt of [undefined, '', '   ']) {
            expect(approvalSummary({ prompt })).toEqual({ muted: 'no question yet' });
        }
    });

    it('shows only the first line of a multi-line question', () => {
        expect(approvalSummary({ prompt: 'Approve the invoice?\nContext: it is overdue.' }))
            .toBe('Approve the invoice?');
    });

    it('truncates a long question rather than letting it wrap the card', () => {
        const long = 'x'.repeat(100);
        const out = approvalSummary({ prompt: long });
        expect(out.length).toBe(60);
        expect(out.endsWith('…')).toBe(true);
    });
});

describe('approval — the deadline chip mirrors what the run enforces', () => {
    it('reads the nested value, then the legacy one, then the default', () => {
        expect(approvalDeadline({ approval: { expiresInHours: 4 } })).toBe('4 hours');
        expect(approvalDeadline({ expiresInHours: 72 })).toBe('3 days');
        expect(approvalDeadline({})).toBe('7 days');
    });

    it('says "No deadline" for 0 rather than "0 hours"', () => {
        expect(approvalDeadline({ approval: { expiresInHours: 0 } })).toBe('No deadline');
    });

    it('prefers the nested value when both are present', () => {
        // Same precedence as the engine's resolveApprovalTtlMs — a card that
        // disagreed with the run would be worse than no card.
        expect(approvalDeadline({ approval: { expiresInHours: 24 }, expiresInHours: 720 })).toBe('1 day');
    });
});

describe('approval — the editor round-trips without losing the deadline', () => {
    const step = (over = {}) => ({ id: 'appr_1', type: 'approval', prompt: 'ok?', ...over });

    it('an untouched approval patches neither the question nor the deadline', () => {
        // buildPatch sends only what CHANGED, so re-saving a step nobody
        // edited must not touch its fields — otherwise opening the editor
        // would clobber a concurrent AI-builder edit to the same step.
        // (label/icon always appear; they are the shared baseline, not ours.)
        const s = step({ approval: { expiresInHours: 72 } });
        const patch = buildPatch(s, extractFormState(s));
        expect(patch.prompt).toBeUndefined();
        expect(patch.approval).toBeUndefined();
    });

    it('editing the question patches only the question', () => {
        const s = step({ approval: { expiresInHours: 72 } });
        const patch = buildPatch(s, { ...extractFormState(s), prompt: 'Really send it?' });
        expect(patch.prompt).toBe('Really send it?');
        expect(patch.approval).toBeUndefined();
    });

    it('"No deadline" is read back as 0, not as unset', () => {
        // The `Number(x) || 0` idiom used elsewhere in formState would turn an
        // absent field into 0 here; 0 being meaningful is what makes that a bug.
        const s = step({ approval: { expiresInHours: 0 } });
        expect(extractFormState(s).expiresInHours).toBe(0);
        // …and choosing it from a 7-day step is a real change.
        const from7d = step({ approval: { expiresInHours: 168 } });
        expect(buildPatch(from7d, { ...extractFormState(from7d), expiresInHours: 0 }).approval)
            .toEqual({ expiresInHours: 0 });
    });

    it('an ABSENT deadline becomes the 7-day default, never "no deadline"', () => {
        const s = step();
        const patch = buildPatch(s, { ...extractFormState(s), expiresInHours: undefined });
        expect(patch.approval).toEqual({ expiresInHours: 168 });
    });

    it('a legacy top-level deadline is shown, then normalised away', () => {
        // One field owns the deadline. Leaving the top-level key behind would
        // let the two disagree, and the engine reads the nested one first.
        const s = step({ expiresInHours: 12 });
        const draft = extractFormState(s);
        expect(draft.expiresInHours).toBe(12);
        const patch = buildPatch(s, draft);
        expect(patch.approval).toEqual({ expiresInHours: 12 });
        expect(patch.expiresInHours).toBeUndefined();
        expect('expiresInHours' in patch).toBe(true); // undefined REMOVES the key
    });

    it('clamps to the engine ceiling', () => {
        const s = step();
        expect(buildPatch(s, { ...extractFormState(s), expiresInHours: 9999 }).approval)
            .toEqual({ expiresInHours: 720 });
        expect(buildPatch(s, { ...extractFormState(s), expiresInHours: -5 }).approval)
            .toEqual({ expiresInHours: 0 });
    });
});

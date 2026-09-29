import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import React from 'react';
import FieldKindIcon, { KIND_ICON } from './FieldKindIcon';
import { KINDS, KIND_WORD } from './fieldKinds';

/**
 * The glyph table is a completeness claim: "every kind the vocabulary knows
 * has a picture". These tests bite on the fail-open shape — a kind that falls
 * back to CircleHelp ("not seen yet") while the schema declares it fully.
 */
describe('FieldKindIcon', () => {
    beforeEach(cleanup);

    it('has a glyph of its own for every kind in KINDS — no kind borrows the unknown icon', () => {
        const missing = KINDS.filter(k => !KIND_ICON[k]);
        expect(missing).toEqual([]);
        // …and only `unknown` may BE the unknown glyph. `choice` reached the
        // vocabulary a round before its icon did and silently rendered
        // CircleHelp, which reads as "we have not seen this value" about a
        // slot whose options are written down in the schema.
        const borrowers = KINDS.filter(k => k !== 'unknown' && KIND_ICON[k] === KIND_ICON.unknown);
        expect(borrowers).toEqual([]);
    });

    it('gives every kind a DISTINCT glyph, so two kinds never read as the same thing', () => {
        const seen = new Map();
        for (const k of KINDS) {
            const icon = KIND_ICON[k];
            expect(seen.has(icon), `${k} shares a glyph with ${seen.get(icon)}`).toBe(false);
            seen.set(icon, k);
        }
    });

    it('renders choice as its own glyph and labels it in words, not in "string"', () => {
        render(<FieldKindIcon kind="choice" />);
        const el = screen.getByLabelText(KIND_WORD.choice.en);
        expect(el.getAttribute('data-kind')).toBe('choice');
    });

    it('still falls back to the unknown glyph for a kind nobody declared', () => {
        // The fallback is not removed — an unknown WORD is genuinely unknown.
        render(<FieldKindIcon kind="totally-made-up" />);
        expect(screen.getByLabelText('totally-made-up')).toBeTruthy();
    });

    it('prefers an explicit title over the kind word for the accessible name', () => {
        render(<FieldKindIcon kind="choice" title="one of: new, won" />);
        expect(screen.getByLabelText('one of: new, won')).toBeTruthy();
    });
});

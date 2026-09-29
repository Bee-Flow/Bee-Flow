import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * "Delivers" — the fields a skill hands to an AI step (`output_schema`).
 *
 * Two claims:
 *   1. the card is a VIEW of the same JSON-schema shape an AI step stores,
 *      through the builder's own `schemaToFields`/`fieldsToSchema` bridge —
 *      so a typed array, a date format and an empty list (which means
 *      `null`, not "an object with no keys") all survive the round trip;
 *   2. it degrades to one line, never to a white screen, if the row editor
 *      it borrows from the AI-step editor is not exported yet. That import
 *      is a cross-file dependency landing in another track's file, and a
 *      missing export renders as `undefined`, which React turns into
 *      "Element type is invalid" on the section's MAIN tab.
 */

afterEach(() => { cleanup(); vi.resetModules(); vi.doUnmock('../../../automation/Builder/flow/settings/aiStepEditors'); });

const SCHEMA = {
    type: 'object',
    properties: {
        total: { type: 'number', 'x-unit': 'EUR' },
        validUntil: { type: 'string', format: 'date-time' },
        status: { type: 'string', enum: ['open', 'won'] },
        lines: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } },
    },
};

async function loadCard({ withEditor }) {
    vi.resetModules();
    vi.doMock('../../../automation/Builder/flow/settings/aiStepEditors', () => (withEditor
        ? {
            StructuredOutputFields: ({ fields, onChange }) => (
                <button type="button" data-testid="rows" onClick={() => onChange([])}>
                    rows: {fields.length}
                </button>
            ),
        }
        // `undefined`, spelled out: vitest's mock proxy THROWS on a key it
        // was not given, while a real ES-module namespace simply answers
        // undefined — which is the case the guard exists for.
        : { StructuredOutputFields: undefined }));
    return (await import('./OutputFieldsCard')).default;
}

describe('the "Delivers" card', () => {
    it('reads each field back in the product\'s own field-kind words, not in JSON types', async () => {
        const Card = await loadCard({ withEditor: true });
        render(<Card outputSchema={SCHEMA} onChange={() => {}} />);
        const summary = screen.getByTestId('skill-output-summary').textContent;
        expect(summary).toContain('number');
        expect(summary).toContain('date');
        expect(summary).toContain('one of a list');
        expect(summary).toContain('table');
        // …including the unit, which is what makes "total" readable at all.
        expect(summary).toContain('EUR');
    });

    it('says a skill delivers nothing rather than showing an empty table', async () => {
        const Card = await loadCard({ withEditor: true });
        render(<Card outputSchema={null} onChange={() => {}} />);
        expect(screen.getByTestId('skill-output-empty')).toBeTruthy();
    });

    it('turns an emptied row list back into null, not into an object with no keys', async () => {
        const Card = await loadCard({ withEditor: true });
        const onChange = vi.fn();
        render(<Card outputSchema={SCHEMA} onChange={onChange} />);
        fireEvent.click(screen.getByTestId('rows'));
        expect(onChange).toHaveBeenCalledWith(null);
    });

    it('hands the row editor the fields the builder itself would show', async () => {
        const Card = await loadCard({ withEditor: true });
        render(<Card outputSchema={SCHEMA} onChange={() => {}} />);
        expect(screen.getByTestId('rows').textContent).toContain('rows: 4');
    });

    it('shows the summary but no editor to a read-only viewer', async () => {
        const Card = await loadCard({ withEditor: true });
        render(<Card outputSchema={SCHEMA} onChange={() => {}} readOnly />);
        expect(screen.getByTestId('skill-output-summary')).toBeTruthy();
        expect(screen.queryByTestId('rows')).toBeNull();
    });

    it('degrades to one line — never a white screen — when the borrowed row editor is missing', async () => {
        const Card = await loadCard({ withEditor: false });
        render(<Card outputSchema={SCHEMA} onChange={() => {}} />);
        expect(screen.getByTestId('skill-output-unavailable')).toBeTruthy();
        expect(screen.getByTestId('skill-output-summary')).toBeTruthy();
    });

    /**
     * EVERY test above mocks aiStepEditors, so not one of them can see which
     * of the two branches the PRODUCT takes. That is not a detail: as long as
     * `StructuredOutputFields` is module-private in aiStepEditors.jsx, this
     * card is READ-ONLY in production while this file is green — the gap that
     * hid the fact through a whole stage.
     *
     * So this one loads the real module and asserts the card follows it. It
     * needs no edit when the one-word `export` lands (a shared edit this
     * track may not make): the rows simply appear, and the assertion holds
     * from the other side. It fails only if the two ever stop agreeing —
     * a guard left behind after the export exists, or a named import that
     * silently resolves to undefined.
     */
    it('follows the REAL aiStepEditors module, which every mocked test above is blind to', async () => {
        vi.resetModules();
        vi.doUnmock('../../../automation/Builder/flow/settings/aiStepEditors');
        const real = await import('../../../automation/Builder/flow/settings/aiStepEditors');
        const Card = (await import('./OutputFieldsCard')).default;
        const onChange = vi.fn();
        render(<Card outputSchema={SCHEMA} onChange={onChange} />);
        const exported = typeof real.StructuredOutputFields === 'function';
        expect(screen.getByTestId('skill-output-summary')).toBeTruthy();
        expect(!!screen.queryByTestId('skill-output-unavailable')).toBe(!exported);

        if (!exported) return;
        // "The fallback is absent" is NOT the same claim as "the editor is
        // there". A module exporting `StructuredOutputFields: () => null` —
        // present, exported, drawing nothing — passed the two assertions
        // above. So: the real editor must actually put an EDITABLE row on
        // screen for every field, and that row must be wired to this card's
        // onChange (which is where fieldsToSchema lives).
        const rows = screen.getAllByPlaceholderText('fieldName');
        expect(rows.length, 'one editable row per field of the schema').toBe(4);
        expect(rows.map(el => el.value)).toEqual(['total', 'validUntil', 'status', 'lines']);
        fireEvent.change(rows[0], { target: { value: 'grandTotal' } });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(Object.keys(onChange.mock.calls[0][0].properties)).toContain('grandTotal');
    });

    /**
     * The two vocabularies, side by side, on purpose.
     *
     * The borrowed editor names the same field in JSON types (`number`,
     * `datetime`, `string`) while the summary above it names it in the words
     * an automation will show (`number`, `date`, `one of a list`). One
     * vocabulary in the shared editor is the real fix and it is R2's file, so
     * what this card owes the reader is a CAPTION that makes the top block a
     * different statement rather than a contradiction of the block below.
     */
    it('captions the summary as what an automation sees, so the two type words are not one claim', async () => {
        const Card = await loadCard({ withEditor: true });
        render(<Card outputSchema={SCHEMA} onChange={() => {}} />);
        expect(screen.getByText(/How an automation will see these/)).toBeTruthy();
    });

    it('leaves the caption off when there is nothing to caption', async () => {
        const Card = await loadCard({ withEditor: true });
        render(<Card outputSchema={null} onChange={() => {}} />);
        expect(screen.queryByText(/How an automation will see these/)).toBeNull();
    });
});

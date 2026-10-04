import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect } from 'vitest';
import SentInputsTable, { buildRows } from './SentInputsTable';

/**
 * "What gets sent", read-first. The interesting cases are all the ones where
 * something is WRONG or MISSING, because those are exactly what the old
 * edit-first panel rendered as a blank form control indistinguishable from a
 * filled-in one.
 */

const CONTRACT = {
    email: { type: 'string', required: true },
    amount: { type: 'number', required: false },
};
const FORM = [
    { name: 'email', type: 'input_text' },
    { name: 'notes', type: 'input_textarea' },
];

describe('buildRows — the answer, including the awkward parts', () => {
    it('reads a declared contract even when nothing is mapped yet', () => {
        const rows = buildRows({ paramMetaByName: CONTRACT, inputMapping: {}, formFields: [] });
        expect(rows.map((r) => r.name)).toEqual(['email', 'amount']);
        // Declared but unbound is a HOLE, not an empty cell: the automation will
        // run with the parameter undefined.
        expect(rows.every((r) => r.missing)).toBe(true);
    });

    it('names the form fields that feed nothing', () => {
        const rows = buildRows({
            paramMetaByName: CONTRACT,
            inputMapping: { email: { kind: 'field', name: 'email' } },
            formFields: FORM,
        });
        const unused = rows.filter((r) => r.unused).map((r) => r.name);
        // `notes` is collected from the person and goes nowhere. Nothing said
        // so before, and the failure looks identical to a broken automation.
        expect(unused).toEqual(['notes']);
    });

    it('accuses nothing when the automation declares no contract', () => {
        // Without a contract there is no way to know an unmapped field is a
        // mistake — the automation may read it some other way. Calling it "not
        // used" would be a claim the screen cannot support.
        const rows = buildRows({
            paramMetaByName: null,
            inputMapping: { whatever: { kind: 'static', value: '1' } },
            formFields: FORM,
        });
        expect(rows.some((r) => r.unused)).toBe(false);
        expect(rows.map((r) => r.name)).toEqual(['whatever']);
    });

    it('survives junk in place of a mapping', () => {
        expect(buildRows({ paramMetaByName: null, inputMapping: 'nonsense', formFields: null })).toEqual([]);
        expect(buildRows({})).toEqual([]);
    });
});

describe('SentInputsTable — what it says out loud', () => {
    it('marks an unbound required parameter rather than leaving the cell blank', () => {
        render(<SentInputsTable paramMetaByName={CONTRACT} inputMapping={{}} formFields={[]} />);
        expect(screen.getAllByText(/nothing yet/i).length).toBe(2);
    });

    it('does not read an EMPTY fixed value as a value', () => {
        render(
            <SentInputsTable
                paramMetaByName={CONTRACT}
                inputMapping={{ email: { kind: 'static', value: '   ' } }}
                formFields={[]}
            />,
        );
        expect(screen.getByText(/an empty value/i)).toBeInTheDocument();
    });

    it('flags a field-mapping with no field chosen', () => {
        render(
            <SentInputsTable
                paramMetaByName={CONTRACT}
                inputMapping={{ email: { kind: 'field', name: '' } }}
                formFields={FORM}
            />,
        );
        expect(screen.getByText(/no field chosen/i)).toBeInTheDocument();
    });

    /**
     * The privacy-shaped one. Every app_trigger run carries the viewer's ID.
     * Saying only "the signed-in user is sent" would let an author believe a
     * name travels with it and write an automation that mails it onward.
     */
    it('says WHAT the signed-in user row carries, not just that it is sent', () => {
        render(
            <SentInputsTable
                paramMetaByName={CONTRACT}
                inputMapping={{ email: { kind: 'field', name: 'email' } }}
                formFields={FORM}
                showViewerRow
            />,
        );
        expect(screen.getByText('Signed-in user')).toBeInTheDocument();
        expect(screen.getByText(/ID only/i)).toBeInTheDocument();
        expect(screen.getByText(/no name or e-mail/i)).toBeInTheDocument();
    });

    it('omits the signed-in user row when the target is not an app_trigger automation', () => {
        render(<SentInputsTable paramMetaByName={CONTRACT} inputMapping={{}} formFields={[]} />);
        expect(screen.queryByText('Signed-in user')).toBeNull();
    });

    it('says nothing is sent rather than rendering an empty table', () => {
        render(<SentInputsTable paramMetaByName={null} inputMapping={{}} formFields={[]} />);
        expect(screen.getByText(/nothing is sent/i)).toBeInTheDocument();
        expect(screen.queryByRole('table')).toBeNull();
    });
});

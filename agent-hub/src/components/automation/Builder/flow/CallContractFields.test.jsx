import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import CallContractFields from './CallContractFields';

/**
 * A flowlet / Step call renders one value slot per DECLARED param, and the
 * declaration is a machine contract: `klant_naam`, `pdf_url`. Those keys were
 * the labels, so the inputs form read like a JSON schema — the complaint this
 * batch answers. The label is now the name of the thing; the key is demoted to
 * the row's title, never dropped, because it is what the binding is stored
 * under and what a power user looks for in the step's JSON.
 *
 * This component has no i18n imports (nor do its two callers in
 * settings/actionEditors/flowletCallFields.jsx) — it is hardcoded English, and
 * the humaniser only re-reads the author's own key, so nothing new is
 * translated here.
 */
const BASE = {
    step: { autoMapped: [] },
    stepType: 'call_layer',
    headerSectionKey: 'flowlet',
    headerTitle: 'Flowlet',
    displayTitle: 'Invoice check',
    inputs: {},
    setInput: () => {},
    onAutoMap: () => {},
    groups: [],
    onFocusField: null,
    previewSample: null,
    inputsHint: 'Map each flowlet parameter to an upstream value.',
    emptyInputsLabel: 'This flowlet has no declared inputs.',
};

function renderFields(contract, extra = {}) {
    render(<CallContractFields {...BASE} contract={contract} {...extra} />);
}

describe('CallContractFields — param rows are named, not keyed', () => {
    beforeEach(cleanup);

    it('reads a raw param key as words and keeps the key on the row', () => {
        renderFields([{ name: 'klant_naam', type: 'string' }]);
        expect(screen.getByText('Klant naam')).toBeTruthy();
        expect(screen.queryByText('klant_naam')).toBeNull();
        // Demoted, not deleted: the exact key is one hover away.
        expect(document.querySelector('[title="klant_naam"]')).toBeTruthy();
    });

    it('uses the proper-noun table for an acronym in the key', () => {
        // `pdf` is in displayHelpers.PROPER_CASE, so this is "PDF url", not
        // "Pdf url". That table is the single place to teach a new acronym —
        // `iban` is not in it yet and therefore still reads "Iban".
        renderFields([{ name: 'pdf_url', type: 'string' }]);
        expect(screen.getByText('PDF url')).toBeTruthy();
    });

    it('lets the contract name the field itself, and falls back when it does not', () => {
        renderFields([
            { name: 'bijlage_url', label: 'Bijlage (link)', type: 'string' },
            { name: 'bedrag', type: 'number' },
        ]);
        // An author-supplied label wins over the humanised key…
        expect(screen.getByText('Bijlage (link)')).toBeTruthy();
        expect(screen.queryByText('Bijlage url')).toBeNull();
        expect(document.querySelector('[title="bijlage_url"]')).toBeTruthy();
        // …and a contract without one is unchanged in behaviour.
        expect(screen.getByText('Bedrag')).toBeTruthy();
    });

    it('still binds under the raw param key', () => {
        // The label is display only. If it ever became the key, every existing
        // mapping in every saved automation would silently stop resolving.
        const setInput = vi.fn();
        render(
            <CallContractFields
                {...BASE}
                setInput={setInput}
                contract={[{ name: 'klant_naam', label: 'Klant', type: 'string' }]}
                inputs={{ klant_naam: { kind: 'literal', value: 'Jansen' } }}
            />,
        );
        expect(screen.getByText('Klant')).toBeTruthy();
        // The value still arrives at the slot keyed by `klant_naam`.
        expect(document.body.textContent).toContain('Jansen');
    });
});

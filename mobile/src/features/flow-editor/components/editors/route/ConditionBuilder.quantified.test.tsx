/**
 * The rule rows on a mail's attachments (R1-R3, R5, R8): File type under
 * Attachments becomes "any attachment · File type · is · PDF", a saved
 * `contains(item.attachments[*].mimeType, "pdf")` reopens as a row, and in
 * Simple mode a formula the rows cannot show is a "Custom rule" card.
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React, { useState } from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ConditionBuilder } from './ConditionBuilder';
import { itemFieldOptions } from './fieldOptions';

jest.setTimeout(30_000);

const T = (_key: string, en: string, vars: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const MAIL = {
    subject: 'Invoice 0042',
    from: 'billing@fabrikam.example',
    attachments: [
        { filename: 'invoice-0042.pdf', mimeType: 'application/pdf' },
        { filename: 'logo.png', mimeType: 'image/png' },
    ],
};
const OPTIONS = itemFieldOptions(MAIL, 'message', T);

function Harness({ initial, onExpr, simple = false }: { initial: string; onExpr: (expr: string) => void; simple?: boolean }) {
    const [value, setValue] = useState(initial);
    return (
        <ConditionBuilder
            value={value}
            onChange={(next) => {
                setValue(next);
                onExpr(next);
            }}
            sampleRoot={{ item: MAIL }}
            context="filter"
            fieldOptions={OPTIONS}
            fieldBase="item"
            simple={simple}
        />
    );
}

describe('ConditionBuilder on the attachments of each message', () => {
    it('picks File type under Attachments as "any attachment", and saves the PDF rule as anyOf (R2, R3)', async () => {
        const onExpr = jest.fn();
        await renderWithProviders(<Harness initial="true" onExpr={onExpr} />);
        await fireEvent.press(screen.getByTestId('condition-row-1-field'));
        await fireEvent.press(await screen.findByText('File type'));
        expect(screen.getByText('any attachment')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('condition-row-1-value-select'));
        await fireEvent.press(screen.getByTestId('condition-row-1-value-option-pdf'));
        expect(onExpr).toHaveBeenLastCalledWith('anyOf(fileType(item.attachments[*]), "equals", "pdf")');
        await fireEvent.press(screen.getByTestId('condition-row-1-quantifier-select'));
        await fireEvent.press(screen.getByTestId('condition-row-1-quantifier-option-none'));
        expect(onExpr).toHaveBeenLastCalledWith('noneOf(fileType(item.attachments[*]), "equals", "pdf")');
    });

    it('reopens the saved mime-type rule as one clickable row, without rewriting it (R5)', async () => {
        const onExpr = jest.fn();
        await renderWithProviders(<Harness initial={'contains(item.attachments[*].mimeType, "pdf")'} onExpr={onExpr} />);
        expect(screen.getByText('any attachment')).toBeTruthy();
        expect(screen.getByText('Mime type')).toBeTruthy();
        expect(screen.getByText('contains')).toBeTruthy();
        expect(screen.queryByLabelText('Expression')).toBeNull();
        expect(onExpr).not.toHaveBeenCalled();
    });

    it('says a list of records never "contains" a text (R9)', async () => {
        await renderWithProviders(<Harness initial={'contains(item.attachments, "pdf")'} onExpr={jest.fn()} />);
        expect(screen.getByText(/Attachments is a list, so “contains” never matches it\./)).toBeTruthy();
    });

    it('in Simple mode shows a formula as a Custom rule card, and rebuilds it by clicking without losing it until a field is picked (R8)', async () => {
        const onExpr = jest.fn();
        await renderWithProviders(<Harness initial={'len(item.subject) > 3 && len(item.from) > 2 || isEmpty(item.attachments)'} onExpr={onExpr} simple />);
        expect(screen.getByTestId('custom-rule-card')).toBeTruthy();
        expect(screen.getByText('It reads: Subject, From, Attachments')).toBeTruthy();
        expect(screen.queryByLabelText('Expression')).toBeNull();
        await fireEvent.press(screen.getByTestId('custom-rule-rebuild'));
        expect(screen.getByText('The formula stays until you pick a field.')).toBeTruthy();
        expect(screen.queryByText('Write raw expression')).toBeNull();
        expect(onExpr).not.toHaveBeenCalled();
        await fireEvent.press(screen.getByTestId('custom-rule-keep'));
        expect(screen.getByTestId('custom-rule-card')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('custom-rule-rebuild'));
        await fireEvent.press(screen.getByTestId('condition-row-1-field'));
        await fireEvent.press(await screen.findByText('Subject'));
        // The rows now speak for the rule: nothing complete yet, so nothing is saved.
        expect(onExpr).toHaveBeenLastCalledWith('');
    });
});

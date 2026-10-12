import { FLATTEN_MAIL_STEP, flattenMailRoot } from '@shared/expr/corpus.mjs';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FlattenColumnsPanel from './FlattenColumnsPanel';
import { flattenDraft, type FlattenDraft } from './flattenEditorModel';

/** Invented Fabrikam invoice mails (corpus.mjs). */
const MAIL = flattenMailRoot();
const DRAFT: FlattenDraft = flattenDraft(FLATTEN_MAIL_STEP as unknown as Record<string, unknown>);
const CHILD_KEYS = ['attachmentId', 'filename', 'mimeType', 'size', 'canOCR', 'messageId', 'threadId'];

function stubWidth(width: number) {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('max-width: 479px') && width <= 479, media: query,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }));
}

beforeEach(() => stubWidth(1200));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FlattenColumnsPanel', () => {
    it('greys the fills, ticks the copies and leaves long text unticked', () => {
        render(<FlattenColumnsPanel draft={DRAFT} sampleRoot={MAIL} childKeys={CHILD_KEYS} onParents={() => {}} />);
        const id = screen.getByRole('checkbox', { name: /^Id/ }) as HTMLInputElement;
        expect(id.checked).toBe(true);
        expect(id.disabled).toBe(true);
        expect(screen.getAllByText('already on each attachment')).toHaveLength(2);
        expect((screen.getByRole('checkbox', { name: /^Subject/ }) as HTMLInputElement).checked).toBe(true);
        expect((screen.getByRole('checkbox', { name: /^Body/ }) as HTMLInputElement).checked).toBe(false);
        expect(screen.getByText('long text')).toBeTruthy();
        expect(screen.getByText('All 7 fields')).toBeTruthy();
    });

    it('a tick writes auto: false', async () => {
        const onParents = vi.fn();
        render(<FlattenColumnsPanel draft={DRAFT} sampleRoot={MAIL} childKeys={CHILD_KEYS} onParents={onParents} />);
        await userEvent.click(screen.getByRole('checkbox', { name: /^Body/ }));
        const parents = onParents.mock.calls[0][0];
        expect(parents[0].auto).toBe(false);
        expect(parents[0].fields.at(-1)).toEqual({ from: 'body', to: 'body', mode: 'copy' });
    });

    it('Reset plans afresh with auto: true', async () => {
        const onParents = vi.fn();
        const edited: FlattenDraft = { ...DRAFT, parents: [{ ...DRAFT.parents![0], auto: false, fields: [] }] };
        render(<FlattenColumnsPanel draft={edited} sampleRoot={MAIL} childKeys={CHILD_KEYS} onParents={onParents} />);
        await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
        expect(onParents).toHaveBeenCalledWith(FLATTEN_MAIL_STEP.parents);
    });

    it('folds to a count below 480px', async () => {
        stubWidth(420);
        render(<FlattenColumnsPanel draft={DRAFT} sampleRoot={MAIL} childKeys={CHILD_KEYS} onParents={() => {}} />);
        const summary = screen.getByTestId('flatten-fields-summary');
        expect(summary.textContent).toBe('6 of 7 fields');
        await userEvent.click(summary);
        expect(screen.getByTestId('flatten-columns-panel')).toBeTruthy();
    });
});

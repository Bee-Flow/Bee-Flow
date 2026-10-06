/**
 * F50: a flatten's rows show as the smart table, pinned on Filename, with
 * Attachment id and Message id on screen although they look technical, and
 * `canOCR` reads "Can OCR".
 */
import { render, screen, within, cleanup } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { FLATTEN_MAIL_STEP, flattenMailRoot } from '@shared/expr/corpus.mjs';
import { flattenRows } from '@shared/expr/flatten.mjs';
import OutputView from '../OutputView';
import { discoverColumns, flattenPromotedKeys, nameColumn, suggestColumns } from './columns';
import { smartRowsOf } from './SmartOutput';

const { dead: _d, over: _o, ...OUT } = flattenRows(flattenMailRoot(), FLATTEN_MAIL_STEP) as Record<string, unknown>;
const ROWS = OUT.items as Record<string, unknown>[];

beforeEach(() => { cleanup(); try { localStorage.clear(); } catch { /* none */ } });

describe('a flatten\'s output table (F50)', () => {
    it('the envelope is a table of its rows (D9: no second list beside items)', () => {
        expect(smartRowsOf(OUT)).toBe(ROWS);
        expect(ROWS).toHaveLength(64);
    });

    it('promotes the child id and each parent\'s own id, not every id', () => {
        expect(flattenPromotedKeys(FLATTEN_MAIL_STEP)).toEqual(['attachmentId', 'messageId']);
        expect(flattenPromotedKeys({ type: 'flatten', arrayRef: 'x.orders[*].items', parents: [] })).toEqual(['itemId']);
        expect(flattenPromotedKeys({ type: 'filter', arrayRef: 'steps.x.output.items' })).toEqual([]);
        expect(flattenPromotedKeys({ type: 'flatten', arrayRef: '' })).toEqual([]);
    });

    it('pins Filename and shows the ids next to it', () => {
        const cols = discoverColumns(ROWS);
        expect(nameColumn(cols)?.key).toBe('filename');
        const shown = suggestColumns(cols, { max: 7, promote: flattenPromotedKeys(FLATTEN_MAIL_STEP) });
        expect(shown.slice(0, 3)).toEqual(['filename', 'attachmentId', 'messageId']);
        expect(shown).toHaveLength(7);
        expect(shown).not.toContain('threadId');
        expect(shown).toEqual(expect.arrayContaining(['date', 'from']));
        expect(suggestColumns(cols, { max: 7 })).not.toContain('attachmentId');
    });

    it('the narrow table keeps a readable mail field next to the ids', () => {
        const shown = suggestColumns(discoverColumns(ROWS), { max: 4, promote: flattenPromotedKeys(FLATTEN_MAIL_STEP) });
        expect(shown.slice(0, 3)).toEqual(['filename', 'attachmentId', 'messageId']);
        expect(shown[3]).not.toMatch(/Id$/);
    });

    it('reads canOCR as "Can OCR"', () => {
        expect(discoverColumns(ROWS).find(c => c.key === 'canOCR')?.label).toBe('Can OCR');
    });

    it('OutputView renders the envelope as the smart table, counts as plain values', () => {
        render(<OutputView fill fieldsView smartTable value={OUT} columnsKey="demo.mf_flatten" />);
        const heads = within(screen.getByTestId('output-smart-table')).getAllByRole('columnheader').map(th => th.textContent);
        expect(heads[0]).toBe('Filename');
    });

    it('with the promoted ids, shows them by default and says no count in chips (F49, F50)', () => {
        render(<OutputView fill fieldsView smartTable value={OUT} columnsKey="demo.mf_flatten.promoted" promote={flattenPromotedKeys(FLATTEN_MAIL_STEP)} />);
        const heads = within(screen.getByTestId('output-smart-table')).getAllByRole('columnheader').map(th => th.textContent);
        expect(heads.slice(0, 3)).toEqual(['Filename', 'Attachment id', 'Message id']);
        expect(screen.queryByTestId('output-smart-scalars')).toBeNull();
    });
});

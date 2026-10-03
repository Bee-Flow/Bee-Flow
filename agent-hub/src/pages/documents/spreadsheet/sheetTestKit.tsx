// Shared by the spreadsheet tests: open the editor on a sheet and hand back
// the user plus a few finders. The test file mocks ./sheetApi (getSheet).

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { withQueryClient } from '../../../test/queryWrapper';
import scopedStorage from '../../../utils/scopedStorage';
import type { StudioDocument } from '../documentQueries';
import SpreadsheetEditor from './SpreadsheetEditor';

export const DOC = { id: 'doc-1', userId: 'u1', name: 'Budget', docType: 'spreadsheet', bodyHtml: '', versionId: 'v1' } as StudioDocument;

type GetSheet = { mockResolvedValue: (v: unknown) => unknown };

export async function openSheet(getSheet: GetSheet, cells: Record<string, string> = {}, readOnly = false) {
    getSheet.mockResolvedValue({ columns: 26, rows: 0, cells, readOnly });
    scopedStorage.setCurrentUser('u1');
    localStorage.clear();
    const user = userEvent.setup();
    const view = render(withQueryClient(<SpreadsheetEditor initial={DOC} people={{}} variant="page" currentUser={{ id: 'u1' }} />));
    await screen.findByRole('grid');
    const cell = (name: string) => view.container.querySelector(`[data-cell="${name}"]`) as HTMLElement;
    const label = () => screen.getByTestId('sheet-status-bar').textContent ?? '';
    const header = (name: string) => screen.getByRole('columnheader', { name });
    const rowHeader = (n: number) => screen.getByRole('rowheader', { name: String(n) });
    return { user, cell, label, header, rowHeader, ...view };
}


/**
 * The attachment badges under a sent message. An upload the server imported
 * as a spreadsheet document (#164) hands its workbook to the share sheet;
 * every other file stays a plain badge.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ApiError } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';
import { readMessage } from '@/features/chat/api/messageReader';
import { importedWorkbookName, importedWorkbookPath, XLSX_MIME } from '@/features/chat/model/importedSheet';
import { renderScreen } from '@/shared/testing/renderWithProviders';

import { AttachmentStrip } from './AttachmentStrip';

jest.mock('@/core/api/shareFile', () => ({ shareServerFile: jest.fn() }));

beforeEach(() => jest.mocked(shareServerFile).mockReset());

it('a plain upload is a badge without a button', async () => {
    await renderScreen(<AttachmentStrip attachments={[{ name: 'notes.pdf' }]} />);
    expect(screen.getByText('notes.pdf')).toBeTruthy();
    expect(screen.queryByText('Share or save…')).toBeNull();
});

it("an imported spreadsheet hands the document's workbook to the share sheet", async () => {
    jest.mocked(shareServerFile).mockResolvedValue('file:///cache/Sales.xlsx');
    await renderScreen(<AttachmentStrip attachments={[{ name: 'Sales.csv', documentId: 'doc 1' }, { name: 'notes.pdf' }]} />);
    await fireEvent.press(screen.getByText('Share or save…'));
    await waitFor(() => expect(shareServerFile).toHaveBeenCalledWith('/api/studio-documents/doc%201/sheet.xlsx', 'Sales.xlsx', XLSX_MIME));
    expect(screen.getAllByText('Share or save…')).toHaveLength(1);
});

it('says why the workbook could not be fetched', async () => {
    jest.mocked(shareServerFile).mockRejectedValue(new ApiError('Document not found.', { status: 404 }));
    await renderScreen(<AttachmentStrip attachments={[{ name: 'Sales.xlsx', documentId: 'd1' }]} />);
    await fireEvent.press(screen.getByText('Share or save…'));
    expect(await screen.findByText('Document not found.')).toBeTruthy();
});

it('the workbook keeps the upload name, as .xlsx', () => {
    expect(importedWorkbookName('Q3 sales.ods')).toBe('Q3 sales.xlsx');
    expect(importedWorkbookName('data.XLSX')).toBe('data.xlsx');
    expect(importedWorkbookName('.csv')).toBe('spreadsheet.xlsx');
    expect(importedWorkbookPath('a/b')).toBe('/api/studio-documents/a%2Fb/sheet.xlsx');
});

it('the stored message carries the imported document id to the chip', () => {
    const msg = readMessage({ id: 'm1', role: 'user', content: 'see file', attachments: [{ name: 'Sales.xlsx', type: 'application/vnd.ms-excel', documentId: 'd1' }, { name: 'a.pdf', documentId: 5 }] });
    expect(msg.attachments?.map((a) => a.documentId)).toEqual(['d1', undefined]);
});

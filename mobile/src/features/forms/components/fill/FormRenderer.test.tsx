/**
 * Every field type a form page can hold, rendered natively and answered:
 * choices (on the page and in a sheet), yes/no, a date's "Today", a file that
 * uploads the moment it is chosen, a record picked from an app, and the files
 * a closing page hands over. A preview shows the same page and sends nothing.
 */

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import * as DocumentPicker from 'expo-document-picker';
import React from 'react';

import type { Answers, FillField, FillForm } from '@/features/forms/model/fillTypes';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { FormRenderer } from './FormRenderer';
import type { FillActions } from './types';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const field = (patch: Partial<FillField> & Pick<FillField, 'name' | 'type'>): FillField => ({
    label: patch.name,
    required: false,
    placeholder: '',
    help: '',
    options: [],
    accept: '',
    maxSizeMb: 10,
    source: '',
    app: '',
    sourceLabel: '',
    searchHint: '',
    multiple: false,
    maxItems: 1,
    fileId: '',
    filename: '',
    mimeType: '',
    size: null,
    ...patch,
});

const form = (fields: FillField[]): FillForm => ({ title: 'Everything', description: '', submitLabel: 'Send', successMessage: 'Thanks', theme: null, fields, multiPage: false });

async function draw(f: FillForm, onSubmit?: (v: Answers) => Promise<void>, actions: FillActions = {}) {
    await renderWithProviders(
        <ToastProvider>
            <FormRenderer form={f} onSubmit={onSubmit} actions={actions} />
        </ToastProvider>,
    );
}

afterEach(async () => {
    jest.clearAllMocks();
    await cleanup();
});

it('answers choices, yes/no and a date, and hands the values over', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ value: `v${i}`, label: `Choice ${i}` }));
    const onSubmit = jest.fn(async () => undefined);
    await draw(
        form([
            field({ name: 'team', type: 'select', label: 'Team', options: [{ value: 'sales', label: 'Sales' }, { value: 'support', label: 'Support' }] }),
            field({ name: 'city', type: 'select', label: 'City', options: many }),
            field({ name: 'agree', type: 'checkbox', label: 'I agree', required: true }),
            field({ name: 'start', type: 'date', label: 'Start' }),
        ]),
        onSubmit,
    );
    await fireEvent.press(screen.getByTestId('fill-submit'));
    expect(await screen.findByText('I agree is required.')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('fill-team-support'));
    await fireEvent.press(screen.getByTestId('fill-city'));
    await fireEvent.press(await screen.findByTestId('fill-city-v7'));
    await fireEvent(screen.getByTestId('fill-agree'), 'valueChange', true);
    await fireEvent.press(screen.getByText('Today'));
    await fireEvent.press(screen.getByTestId('fill-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const values = (onSubmit.mock.calls[0] as unknown as [Answers])[0];
    expect(values).toMatchObject({ team: 'support', city: 'v7', agree: true });
    expect(String(values.start)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

it('takes a number with a decimal comma on a number pad, and still refuses one that is not a number', async () => {
    const onSubmit = jest.fn(async () => undefined);
    await draw(form([field({ name: 'hours', type: 'number', label: 'Hours' }), field({ name: 'start', type: 'date', label: 'Start' })]), onSubmit);
    expect(screen.getByTestId('fill-hours').props.keyboardType).toBe('numeric');
    expect(screen.getByTestId('fill-start').props.keyboardType).toBe('numeric');

    await fireEvent.changeText(screen.getByTestId('fill-hours'), '1.000,5');
    await fireEvent.press(screen.getByTestId('fill-submit'));
    expect(await screen.findByText('Enter a number.')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('fill-hours'), '1,5');
    await fireEvent.press(screen.getByTestId('fill-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.queryByText('Enter a number.')).toBeNull();
});

it('uploads a chosen file at once and keeps only its descriptor', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cv.pdf', name: 'cv.pdf', mimeType: 'application/pdf', size: 2048 }] });
    const upload = jest.fn(async () => ({ fileId: 'up1', filename: 'cv.pdf', size: 2048, mimeType: 'application/pdf' }));
    const onSubmit = jest.fn(async () => undefined);
    await draw(form([field({ name: 'cv', type: 'file', label: 'CV', accept: 'application/pdf,.pdf', maxSizeMb: 5 })]), onSubmit, { upload });
    await fireEvent.press(screen.getByTestId('fill-cv'));
    expect(await screen.findByText('cv.pdf')).toBeTruthy();
    expect(DocumentPicker.getDocumentAsync).toHaveBeenCalledWith(expect.objectContaining({ type: ['application/pdf'] }));
    await fireEvent.press(screen.getByTestId('fill-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls[0] as unknown as [Answers])[0].cv).toEqual({ kind: 'form_upload', fileId: 'up1', filename: 'cv.pdf', size: 2048 });
});

it('refuses a file over the question’s size before sending a byte', async () => {
    (DocumentPicker.getDocumentAsync as jest.Mock).mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///big.pdf', name: 'big.pdf', mimeType: 'application/pdf', size: 9 * 1024 * 1024 }] });
    const upload = jest.fn();
    await draw(form([field({ name: 'cv', type: 'file', label: 'CV', maxSizeMb: 5 })]), jest.fn(), { upload });
    await fireEvent.press(screen.getByTestId('fill-cv'));
    // Said where the question is, and announced: a screen reader hears it without hunting for it.
    expect((await screen.findByText('That file is larger than 5 MB.')).props.accessibilityLiveRegion).toBe('polite');
    expect(upload).not.toHaveBeenCalled();
});

it('searches the app a question names and picks a record', async () => {
    const searchApp = jest.fn(async () => ({ results: [{ id: 'r1', title: 'Kick-off call', subtitle: 'Monday' }], error: null }));
    const onSubmit = jest.fn(async () => undefined);
    await draw(form([field({ name: 'call', type: 'app_pick', label: 'Call', source: 'fireflies', app: 'Fireflies', required: true })]), onSubmit, { searchApp });
    await fireEvent.press(screen.getByTestId('fill-call'));
    await fireEvent.press(await screen.findByTestId('fill-call-result-r1', {}, { timeout: 3000 }));
    expect(await screen.findByText('Kick-off call')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('fill-submit'));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls[0] as unknown as [Answers])[0].call).toEqual({ kind: 'app_pick', source: 'fireflies', recordId: 'r1', title: 'Kick-off call' });
});

it('hands over a file the routine made', async () => {
    const shareFile = jest.fn(async () => undefined);
    await draw(form([field({ name: 'doc', type: 'download', label: 'Your document', fileId: 'g1', filename: 'report.pdf', size: 3 * 1024 * 1024 })]), jest.fn(), { shareFile });
    expect(screen.getByText('PDF · 3.0 MB')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('fill-file-doc'));
    await waitFor(() => expect(shareFile).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'g1' })));
});

it('previews a page without sending it', async () => {
    await draw(form([field({ name: 'n', type: 'text', label: 'Name', required: true })]));
    expect(screen.getByTestId('fill-submit').props.accessibilityState).toMatchObject({ disabled: true });
});

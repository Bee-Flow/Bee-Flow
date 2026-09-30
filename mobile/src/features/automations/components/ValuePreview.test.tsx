/**
 * A value drawn for reading: fields and columns headed by their key made
 * readable ("From email", not FROM_EMAIL), every word through t(), and the
 * exact characters one tap away. `bare` draws the readable form alone, for a
 * caller that owns the toggle (the flow editor's Output tab).
 *
 * Run: cd mobile && ./node_modules/.bin/jest src/features/automations/components/ValuePreview.test.tsx
 */

import { fireEvent, screen } from '@testing-library/react-native';
import React from 'react';

import { renderWithProviders } from '@/shared/testing/renderWithProviders';

import { ValuePreview } from './ValuePreview';
import { MAX_PREVIEW_ROWS } from '../model/values';

describe('ValuePreview', () => {
    it('heads a record’s fields with readable names, and booleans read as words', async () => {
        await renderWithProviders(<ValuePreview label="Received" value={{ from_email: 'ann@x.nl', messageCount: 3, is_read: false }} />);
        expect(screen.getByText('From email')).toBeTruthy();
        expect(screen.getByText('Message count')).toBeTruthy();
        expect(screen.getByText('Is read')).toBeTruthy();
        expect(screen.getByText('No')).toBeTruthy();
        for (const raw of ['FROM_EMAIL', 'from_email', 'MESSAGECOUNT', 'false']) expect(screen.queryByText(raw)).toBeNull();
    });

    it('heads a table’s columns the same way and says how many rows it holds', async () => {
        const rows = Array.from({ length: MAX_PREVIEW_ROWS + 5 }, (_, i) => ({ file_name: `f${i}.pdf`, size_bytes: i }));
        await renderWithProviders(<ValuePreview label="Received" value={rows} />);
        expect(screen.getByText('File name')).toBeTruthy();
        expect(screen.getByText('Size bytes')).toBeTruthy();
        expect(screen.getByText(`Showing ${MAX_PREVIEW_ROWS} of ${MAX_PREVIEW_ROWS + 5} rows`)).toBeTruthy();
    });

    it('counts a short table plainly', async () => {
        await renderWithProviders(<ValuePreview label="Received" value={[{ a: 1 }]} />);
        expect(screen.getByText('1 row')).toBeTruthy();
    });

    it('shows the exact JSON on "Show raw", and names the way back after what it was', async () => {
        await renderWithProviders(<ValuePreview label="Received" value={[{ a: 1 }, { a: 2 }]} />);
        await fireEvent.press(screen.getByText('Show raw'));
        expect(screen.getByText(/"a": 1/)).toBeTruthy();
        expect(screen.getByText('Show table')).toBeTruthy();
    });

    it('calls the way back from a record "Show fields" and from a list "Show list"', async () => {
        await renderWithProviders(
            <>
                <ValuePreview label="Sent" value={{ a: 1 }} />
                <ValuePreview label="Received" value={['x', 'y']} />
            </>,
        );
        const [first, second] = screen.getAllByText('Show raw');
        await fireEvent.press(first as never);
        await fireEvent.press(second as never);
        expect(screen.getByText('Show fields')).toBeTruthy();
        expect(screen.getByText('Show list')).toBeTruthy();
    });

    it('offers no toggle for a single literal', async () => {
        await renderWithProviders(<ValuePreview label="Received" value={42} />);
        expect(screen.getByText('42')).toBeTruthy();
        expect(screen.queryByText('Show raw')).toBeNull();
    });

    it('bare: the readable form alone, no heading and no toggle', async () => {
        await renderWithProviders(<ValuePreview label="Received" value={{ note: 'ok' }} bare />);
        expect(screen.getByText('Note')).toBeTruthy();
        expect(screen.queryByText('RECEIVED')).toBeNull();
        expect(screen.queryByText('Show raw')).toBeNull();
    });
});

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataProvider } from '../DataContext';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';
import AppAiChat from './AppAiChat';
import AppConnectorStatus from './AppConnectorStatus';
import AppFileGallery from './AppFileGallery';
import AppFilePreview from './AppFilePreview';
import { expectPartsMatch } from './recordPartClassKit';

/**
 * LK7b, record family (the types that read through authFetch): every part a type
 * declares renders, and no undeclared `bfa-` class does.
 */

const authFetch = vi.hoisted(() => vi.fn());
vi.mock('@/utils/helpers', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    API_BASE: 'https://api.test',
    authFetch: (...args: unknown[]) => authFetch(...args),
}));
vi.mock('./pdfCompare/pdfEngine', () => ({ openPdf: vi.fn(), isRenderCancelled: () => false }));

function mount(Component: ComponentType<{ node: never }>, node: Record<string, unknown>, runtime: Record<string, unknown> = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }), mode: 'run', ...runtime } as never;
    return render(
        <DataProvider appId="app_1">
            <RuntimeProvider value={value}><Component node={node as never} /></RuntimeProvider>
        </DataProvider>,
    ).container;
}

const stat = (value: unknown) => ({ kind: 'static', value });
const base = (type: string, props: Record<string, unknown>) => ({ id: `cmp_${type}`, type, visible: true, props, style: { span: 12, height: 'lg' } });
const blob = (type: string) => ({ ok: true, status: 200, blob: async () => new Blob(['x'], { type }), json: async () => ({}) });

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockResolvedValue(blob('image/jpeg'));
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:part');
    globalThis.URL.revokeObjectURL = vi.fn();
});

describe('part classes: record types that fetch', () => {
    it('file_gallery (cards, a stored-image thumbnail, groups)', async () => {
        const rows = [
            { id: 'a', name: 'door', kind: 'x', size: 900, file: { kind: 'studio_attachment', fileId: 'file_a', name: 'door.jpg', mime: 'image/jpeg' } },
            { id: 'b', name: 'plan', kind: 'x', size: 2048, file: { kind: 'studio_attachment', fileId: 'file_b', name: 'plan.pdf', mime: 'application/pdf' } },
        ];
        const props = { source: stat(rows), fileKey: 'file', titleKey: 'name', subtitleKey: 'kind', sizeKey: 'size', columns: 2 };
        const grouped = mount(AppFileGallery, base('file_gallery', { ...props, groupKey: 'kind' }));
        await waitFor(() => expect(grouped.querySelector('img')).toBeTruthy());
        expectPartsMatch('file_gallery', [grouped]);
    });

    it('connector_status (card, title, detail, note and the check button)', async () => {
        authFetch.mockImplementation(async (url: string) => ({
            ok: true,
            status: 200,
            json: async () => (String(url).includes('/refresh')
                ? { rowsWritten: 2 }
                : { connectors: [{ id: 'conn_1', provider: 'gmail', connected: true, lastRunAt: null, hasError: false, syncable: true }] }),
        }));
        const live = mount(AppConnectorStatus, base('connector_status', { connectorId: 'conn_1', title: null, showSync: true }));
        await userEvent.click(await screen.findByRole('button', { name: /Check now/ }));
        await screen.findByText(/new|Up to date/);
        expectPartsMatch('connector_status', [live]);
    });

    it('file_preview (header, frame, image and the message states)', async () => {
        const pdf = { kind: 'studio_attachment', fileId: 'f1', name: 'invoice.pdf', mime: 'application/pdf', size: 10 };
        const props = (value: unknown) => ({ source: stat(value), emptyText: 'None', allowDownload: true, viewer: 'browser' });
        authFetch.mockResolvedValue(blob('application/pdf'));
        const framed = mount(AppFilePreview, base('file_preview', props(pdf)));
        await waitFor(() => expect(framed.querySelector('iframe')).toBeTruthy());
        authFetch.mockResolvedValue(blob('image/png'));
        const image = mount(AppFilePreview, base('file_preview', props({ ...pdf, mime: 'image/png', name: 'scan.png' })));
        await waitFor(() => expect(image.querySelector('img')).toBeTruthy());
        authFetch.mockResolvedValue(blob('text/html'));
        const download = mount(AppFilePreview, base('file_preview', props({ ...pdf, mime: 'text/html', name: 'page.html' })));
        await waitFor(() => expect(download.querySelector('.bfa-file_preview__message')).toBeTruthy());
        expectPartsMatch('file_preview', [framed, image, download]);
    });

    it('ai_chat (greeting, starters, both kinds of message, the input and send)', async () => {
        const enc = new TextEncoder();
        const frames = [{ type: 'text', text: 'Hello' }, { type: 'done' }].map((e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        let i = 0;
        authFetch.mockResolvedValue({
            ok: true,
            status: 200,
            body: { getReader: () => ({ read: async () => (i < frames.length ? { done: false, value: frames[i++] } : { done: true, value: undefined }) }) },
        });
        const chat = mount(AppAiChat, base('ai_chat', { greeting: 'Hi', starters: ['What now?'], mode: 'chat' }));
        expect(chat.querySelector('.bfa-ai_chat__greeting')).toBeTruthy();
        const greeting = chat.cloneNode(true) as Element;
        await userEvent.type(screen.getByLabelText('Message'), 'hi');
        await userEvent.click(screen.getByLabelText('Send'));
        await waitFor(() => expect(chat.textContent).toContain('Hello'));
        expectPartsMatch('ai_chat', [chat, greeting]);
    });
});

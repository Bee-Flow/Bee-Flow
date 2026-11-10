import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/** One stubbed fetch for the file: the first route whose text the URL contains answers. */
type Answer = () => Response;
let routes: Array<[string, Answer]> = [];
const answer = (match: string, make: Answer) => { routes = [[match, make], ...routes]; };

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
// jsdom's Blob has no stream(), so a Response cannot wrap one: hand back the parts a loader reads.
const blob = (type: string): Answer => () => ({ ok: true, status: 200, headers: new Headers(), blob: async () => new Blob(['x'], { type }), json: async () => ({}) }) as unknown as Response;
const json = (body: unknown): Answer => () => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    routes = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const hit = routes.find(([match]) => String(url).includes(match));
        return hit ? hit[1]() : new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }));
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:part');
    globalThis.URL.revokeObjectURL = vi.fn();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('part classes: record types that fetch', () => {
    it('file_gallery (cards, a stored-image thumbnail, groups)', async () => {
        const rows = [
            { id: 'a', name: 'door', kind: 'x', size: 900, file: { kind: 'studio_attachment', fileId: 'file_a', name: 'door.jpg', mime: 'image/jpeg' } },
            { id: 'b', name: 'plan', kind: 'x', size: 2048, file: { kind: 'studio_attachment', fileId: 'file_b', name: 'plan.pdf', mime: 'application/pdf' } },
        ];
        answer('/attachments/', blob('image/jpeg'));
        const props = { source: stat(rows), fileKey: 'file', titleKey: 'name', subtitleKey: 'kind', sizeKey: 'size', columns: 2 };
        const grouped = mount(AppFileGallery, base('file_gallery', { ...props, groupKey: 'kind' }));
        await waitFor(() => expect(grouped.querySelector('img')).toBeTruthy());
        expectPartsMatch('file_gallery', [grouped]);
    });

    it('connector_status (card, title, detail, note and the check button)', async () => {
        answer('/connectors/status', json({ connectors: [{ id: 'conn_1', provider: 'gmail', connected: true, lastRunAt: null, hasError: false, syncable: true }] }));
        answer('/refresh', json({ rowsWritten: 2 }));
        const live = mount(AppConnectorStatus, base('connector_status', { connectorId: 'conn_1', title: null, showSync: true }));
        await userEvent.click(await screen.findByRole('button', { name: /Check now/ }));
        await screen.findByText(/new|Up to date/);
        expectPartsMatch('connector_status', [live]);
    });

    it('file_preview (header, frame, image and the message states)', async () => {
        const pdf = { kind: 'studio_attachment', fileId: 'f1', name: 'invoice.pdf', mime: 'application/pdf', size: 10 };
        const props = (value: unknown) => ({ source: stat(value), emptyText: 'None', allowDownload: true, viewer: 'browser' });
        answer('/attachments/', blob('application/pdf'));
        const framed = mount(AppFilePreview, base('file_preview', props(pdf)));
        await waitFor(() => expect(framed.querySelector('iframe')).toBeTruthy());
        answer('/attachments/', blob('image/png'));
        const image = mount(AppFilePreview, base('file_preview', props({ ...pdf, mime: 'image/png', name: 'scan.png' })));
        await waitFor(() => expect(image.querySelector('img')).toBeTruthy());
        answer('/attachments/', blob('text/html'));
        const download = mount(AppFilePreview, base('file_preview', props({ ...pdf, mime: 'text/html', name: 'page.html' })));
        await waitFor(() => expect(download.querySelector('.bfa-file_preview__message')).toBeTruthy());
        expectPartsMatch('file_preview', [framed, image, download]);
    });

    it('ai_chat (greeting, starters, both kinds of message, the input and send)', async () => {
        const frames = [{ type: 'text', text: 'Hello' }, { type: 'done' }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
        answer('/ai/chat', () => new Response(frames, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
        const chat = mount(AppAiChat, base('ai_chat', { greeting: 'Hi', starters: ['What now?'], mode: 'chat' }));
        expect(chat.querySelector('.bfa-ai_chat__greeting')).toBeTruthy();
        const greeting = chat.cloneNode(true) as Element;
        await userEvent.type(screen.getByLabelText('Message'), 'hi');
        await userEvent.click(screen.getByLabelText('Send'));
        await waitFor(() => expect(chat.textContent).toContain('Hello'));
        expectPartsMatch('ai_chat', [chat, greeting]);
    });
});

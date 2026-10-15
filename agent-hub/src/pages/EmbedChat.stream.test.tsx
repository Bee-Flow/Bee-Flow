import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { queryWrapper } from '../test/queryWrapper';
import EmbedChat from './EmbedChat';
import { reply, streamResponseOf } from './EmbedChat.testkit';

/**
 * Characterisation of the embed's turn: how each server-sent event of the
 * agent stream lands on the transcript (answer text, replacement, redaction
 * and policy-violation marks, tool progress, drafts and their de-duplication,
 * knowledge sources, media), what the request carries, what a failed request
 * shows, and the embedder's URL parameters (theme, warning, fonts, colours).
 * MessageItem is a stub that prints the message it is handed.
 */

vi.mock('../components/chat/MessageItem', () => ({
    default: ({ msg }: { msg: { role: string } }) => <pre data-testid={`msg-${msg.role}`}>{JSON.stringify(msg)}</pre>,
}));

let fetchSpy: MockInstance<typeof fetch>;
let events: Array<[string, unknown]> = [];
let streamOk = true;

const sse = () => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

let embedStatus = 200;
beforeEach(() => {
    events = [];
    streamOk = true;
    embedStatus = 200;
    window.history.replaceState({}, '', '/embed');
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('/agents/a1/embed')) return reply({ id: 'a1', name: 'Helper', description: 'Desc', avatar: '', starterPrompts: ['Hi there'], copyEnabled: false }, embedStatus);
        if (url.endsWith('/agents/a1/chat/stream')) return streamResponseOf(sse(), streamOk);
        return reply({});
    });
});
afterEach(() => { fetchSpy.mockRestore(); document.head.querySelectorAll('style,link').forEach((n) => n.remove()); document.documentElement.removeAttribute('data-theme'); });

const streamCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/chat/stream'));

async function sendText(text: string) {
    render(<EmbedChat agentId="a1" />, { wrapper: queryWrapper() });
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox');
    await user.type(box, `${text}{Enter}`);
    await waitFor(() => expect(streamCalls().length).toBe(1));
    return user;
}

const assistant = async () => {
    const node = await screen.findByTestId('msg-assistant');
    return JSON.parse(node.textContent || '{}');
};
const settled = async () => { await waitFor(() => expect(JSON.parse(screen.getByTestId('msg-assistant').textContent || '{}').isStreaming).toBe(false)); return assistant(); };

describe('EmbedChat: stream events', () => {
    it('appends content, then replaces it, and ends the turn', async () => {
        events = [['content', { text: 'Hel' }], ['content', { text: 'lo' }], ['content_replace', { text: 'Hello world' }]];
        await sendText('hi');
        const m = await settled();
        expect(m.content).toBe('Hello world');
        expect(m.isStreaming).toBe(false);
        expect(JSON.parse(screen.getByTestId('msg-user').textContent || '{}').content).toBe('hi');
    });

    it('sends the history with the current message, ephemeral, and the visitor fields', async () => {
        events = [['content', { text: 'A' }]];
        await sendText('first');
        await settled();
        const body = JSON.parse(String((streamCalls()[0][1] as RequestInit).body));
        expect(body).toMatchObject({ message: 'first', history: [{ role: 'user', content: 'first' }], attachments: [], ephemeral: true });
    });

    it('tracks a thinking tool through start and end', async () => {
        events = [
            ['tool_start', { name: 'sequentialthinking', args: { thought: 't1', thoughtNumber: 1, totalThoughts: 2 } }],
            ['tool_end', { name: 'sequentialthinking', result: 'ok' }],
        ];
        await sendText('hi');
        const m = await settled();
        expect(m.thinkingSteps).toHaveLength(1);
        expect(m.thinkingSteps[0]).toMatchObject({ thought: 't1', thoughtNumber: 1, totalThoughts: 2, status: 'done' });
        expect(m.toolResults).toEqual([{ name: 'sequentialthinking', result: 'ok' }]);
        expect(m.toolCall).toBeNull();
    });

    it('shows a running tool call for another tool', async () => {
        events = [['tool_start', { name: 'search' }]];
        await sendText('hi');
        const m = await settled();
        expect(m.toolCall).toEqual({ name: 'search', status: 'running' });
        expect(m.thinkingSteps).toBeUndefined();
    });

    it('accumulates thinking text', async () => {
        events = [['thinking', { text: 'a' }], ['thinking', { text: 'b' }], ['thinking', {}]];
        await sendText('hi');
        expect((await settled()).thinking).toBe('ab');
    });

    it('de-duplicates drafts by their key fields and keeps distinct ones', async () => {
        const mail = { to: 'a@b.c', subject: 's', body: 'b' };
        const cal = { action: 'create', title: 'T', startTime: '1', endTime: '2' };
        events = [
            ['email_draft', mail], ['email_draft', mail], ['email_draft', { ...mail, subject: 'other' }],
            ['calendar_draft', cal], ['calendar_draft', cal],
            ['contacts_draft', { name: 'N', email: 'e', phone: 'p' }], ['contacts_draft', { name: 'N', email: 'e', phone: 'p' }],
            ['keep_draft', { title: 'K', content: 'c' }], ['keep_draft', { title: 'K', content: 'c' }],
            ['linkedin_draft', { text: 'x' }], ['linkedin_draft', { text: 'x' }],
        ];
        await sendText('hi');
        const m = await settled();
        expect(m.emailDrafts).toHaveLength(2);
        expect(m.emailDrafts[0]).toMatchObject({ ...mail, status: 'pending' });
        expect(m.calendarDrafts).toHaveLength(1);
        expect(m.contactsDrafts).toHaveLength(1);
        expect(m.keepDrafts).toHaveLength(1);
        expect(m.linkedInDrafts).toHaveLength(2);
    });

    it('merges knowledge sources, skipping ones whose first 100 characters were already seen', async () => {
        events = [['kb_sources', { sources: [{ content: 'one' }, { content: 'two' }] }], ['kb_sources', { sources: [{ content: 'two' }, { content: 'three' }] }], ['kb_sources', {}]];
        await sendText('hi');
        expect((await settled()).kbSources.map((s: { content: string }) => s.content)).toEqual(['one', 'two', 'three']);
    });

    it('adds media only when the payload has what it needs', async () => {
        events = [
            ['map_embed', { embedUrl: 'u' }],
            ['image', { data: 'abc', mimeType: 'image/png' }], ['image', { data: 'abc' }],
            ['audio', { url: 'a.mp3' }], ['audio', {}],
            ['file', { url: 'f' }], ['file', { name: 'no url' }],
            ['video', { url: 'v', mimeType: 'video/mp4' }], ['video', { url: 'v' }],
        ];
        await sendText('hi');
        const m = await settled();
        expect(m.mapEmbeds).toEqual([{ embedUrl: 'u' }]);
        expect(m.images).toEqual([{ data: 'abc', mimeType: 'image/png' }]);
        expect(m.audioFiles).toEqual([{ url: 'a.mp3', mimeType: 'audio/mpeg', source: 'elevenlabs' }]);
        expect(m.files).toEqual([{ url: 'f' }]);
        expect(m.videoFiles).toEqual([{ url: 'v', mimeType: 'video/mp4' }]);
    });

    it('shows a server error event on the answer', async () => {
        events = [['error', { error: 'boom' }]];
        await sendText('hi');
        const m = await settled();
        expect(m).toMatchObject({ content: 'boom', isError: true, isStreaming: false });
    });

    it('marks the visitor message on a policy violation and replaces it after the countdown', async () => {
        events = [['guardrail_violation', { autoDeleteSeconds: 0.4 }]];
        await sendText('bad');
        await waitFor(() => expect(JSON.parse(screen.getByTestId('msg-user').textContent || '{}')).toMatchObject({ isGuardrailViolation: true, deleteIn: 0.4 }));
        await waitFor(() => expect(JSON.parse(screen.getByTestId('msg-user').textContent || '{}')).toMatchObject({ content: '[Message removed - policy violation]', isDeleted: true, isGuardrailViolation: false }));
    });

    it('redacts the visitor message after the countdown', async () => {
        events = [['content_redact', { autoRedactSeconds: 0.4, redactedMessage: 'my [REDACTED]' }]];
        await sendText('my secret');
        await waitFor(() => expect(JSON.parse(screen.getByTestId('msg-user').textContent || '{}')).toMatchObject({ willRedact: true, isGuardrailViolation: true }));
        await waitFor(() => expect(JSON.parse(screen.getByTestId('msg-user').textContent || '{}')).toMatchObject({ content: 'my [REDACTED]', isRedacted: true, willRedact: false }));
    });

    it('ignores a data line that is not JSON and an unknown event', async () => {
        events = [['whatever', { a: 1 }], ['content', { text: 'ok' }]];
        await sendText('hi');
        expect((await settled()).content).toBe('ok');
    });

    it('shows an apology when the request fails', async () => {
        streamOk = false;
        await sendText('hi');
        const m = await settled();
        expect(m).toMatchObject({ content: 'Sorry, something went wrong. Please try again.', isError: true });
    });
});

describe('EmbedChat: the shell', () => {
    it('shows the agent name and description in the header', async () => {
        render(<EmbedChat agentId="a1" />, { wrapper: queryWrapper() });
        expect((await screen.findAllByText('Helper')).length).toBeGreaterThan(0);
        expect(screen.getAllByText('Desc').length).toBeGreaterThan(0);
    });

    it('shows a specific message for a forbidden, a missing and a failing agent', async () => {
        for (const [status, text] of [[403, 'This agent is not available for embedding.'], [404, 'Agent not found.'], [500, 'Failed to load agent.']] as const) {
            embedStatus = status;
            const { unmount } = render(<EmbedChat agentId="a1" />, { wrapper: queryWrapper() });
            expect(await screen.findByText(text)).toBeTruthy();
            unmount();
        }
    });

    it('says it cannot connect when the request throws', async () => {
        fetchSpy.mockRejectedValue(new Error('net'));
        render(<EmbedChat agentId="a1" />, { wrapper: queryWrapper() });
        expect(await screen.findByText('Failed to connect to server.')).toBeTruthy();
    });

    it('takes the theme from the URL, toggles it and applies it to the document', async () => {
        window.history.replaceState({}, '', '/embed?theme=light');
        render(<EmbedChat agentId="a1" />, { wrapper: queryWrapper() });
        await screen.findAllByText('Helper');
        expect(document.documentElement.getAttribute('data-theme')).toBe('light');
        await userEvent.click(screen.getByTitle('Switch to dark mode'));
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('injects the font, size and colour overrides from the URL', async () => {
        window.history.replaceState({}, '', '/embed?font=Lato&fontSize=15&lineHeight=1.4&userColor=%23112233&assistantColor=%23eeeeee');
        render(<EmbedChat agentId="a1" />, { wrapper: queryWrapper() });
        await screen.findAllByText('Helper');
        const link = document.head.querySelector('link[rel="stylesheet"]') as HTMLLinkElement;
        expect(link.href).toContain('family=Lato');
        const css = document.head.querySelector('style')?.textContent || '';
        expect(css).toContain("font-family: 'Lato', sans-serif !important");
        expect(css).toContain('font-size: 15px !important');
        expect(css).toContain('line-height: 1.4 !important');
        expect(css).toContain('--user-bubble-bg: #112233 !important');
        expect(css).toContain('--bg-secondary: #eeeeee !important');
    });

    it('passes the embedder warning text to the composer', async () => {
        window.history.replaceState({}, '', '/embed?warning=Be%20careful%20here');
        render(<EmbedChat agentId="a1" />, { wrapper: queryWrapper() });
        expect(await screen.findByText('Be careful here')).toBeTruthy();
    });

    it('sends a starter prompt from the welcome screen', async () => {
        events = [['content', { text: 'yo' }]];
        render(<EmbedChat agentId="a1" />, { wrapper: queryWrapper() });
        await userEvent.click(await screen.findByText('Hi there'));
        await waitFor(() => expect(streamCalls().length).toBe(1));
        expect((await settled()).content).toBe('yo');
    });
});

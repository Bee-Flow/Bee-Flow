import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { queryWrapper } from '../test/queryWrapper';
import EmbedChatJs from './EmbedChat';

/**
 * The embed for website visitors: the AI line before the first message, the
 * chat-signals notice when the organisation counts embedded agents, and the
 * marker that says this turn's visitor saw that notice. The network is a spy
 * on fetch: the embed payload, the stream, and an empty object for the rest.
 */

const EmbedChat = EmbedChatJs as unknown as React.ComponentType<{ agentId: string }>;

const VERSION = '2026-10-14T09:00:00.000Z';
const NOTICE_ON = { state: 'on', from: '2026-10-14', version: VERSION, signals: ['outcomes'], privacyNoticeUrl: 'https://www.example.org/privacy' };

let complianceNotice: Record<string, unknown> | undefined;
let fetchSpy: MockInstance<typeof fetch>;

function streamResponse() {
    const chunks = ['event: content\ndata: {"text":"Hi."}\n\n'].map((c) => new TextEncoder().encode(c));
    let i = 0;
    return {
        ok: true,
        status: 200,
        body: {
            getReader: () => ({
                read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
            }),
        },
    } as unknown as Response;
}

const reply = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as unknown as Response;

beforeEach(() => {
    complianceNotice = NOTICE_ON;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('/agents/a1/embed')) {
            return reply({ id: 'a1', name: 'Helper', description: '', avatar: '', starterPrompts: [], copyEnabled: false, complianceNotice });
        }
        if (url.endsWith('/agents/a1/chat/stream')) return streamResponse();
        return reply({});
    });
});
afterEach(() => { fetchSpy.mockRestore(); });

const renderEmbed = () => render(<EmbedChat agentId="a1" />, { wrapper: queryWrapper() });

async function send(text: string) {
    const user = userEvent.setup();
    const box = await screen.findByRole('textbox');
    await user.type(box, `${text}{Enter}`);
    await waitFor(() => expect(streamCalls().length).toBeGreaterThan(0));
    return user;
}

const streamCalls = () => fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/chat/stream'));
const lastBody = () => JSON.parse(String((streamCalls().at(-1)?.[1] as RequestInit).body));

describe('EmbedChat: before the first message', () => {
    it('shows the AI line and the visitor notice in the empty state', async () => {
        renderEmbed();
        expect((await screen.findByTestId('embed-ai-disclosure')).textContent).toBe('You are chatting with an AI assistant, not a person.');
        expect(screen.getByTestId('embed-monitoring-notice')).toBeTruthy();
        expect(streamCalls()).toHaveLength(0);
    });

    it('shows the AI line even when chat signals are off', async () => {
        complianceNotice = undefined;
        renderEmbed();
        expect(await screen.findByTestId('embed-ai-disclosure')).toBeTruthy();
        expect(screen.queryByTestId('embed-monitoring-notice')).toBeNull();
    });
});

describe('EmbedChat: the marker on the stream request', () => {
    it('carries agent_public@<version> when the notice was shown', async () => {
        renderEmbed();
        await screen.findByTestId('embed-monitoring-notice');
        await send('Hello');
        expect(lastBody().chatSignalsNotice).toBe(`agent_public@${VERSION}`);
        expect(lastBody()).not.toHaveProperty('chatSignalsOptOut');
        // Afterwards the notice stays as a compact line, and the AI line stays on top.
        expect(await screen.findByTestId('embed-monitoring-notice')).toBeTruthy();
        expect(screen.getByTestId('embed-ai-disclosure')).toBeTruthy();
    });

    it('carries no marker when the embed announces nothing', async () => {
        complianceNotice = { state: 'off', from: null, version: null, signals: [], privacyNoticeUrl: null };
        renderEmbed();
        await screen.findByTestId('embed-ai-disclosure');
        await send('Hello');
        expect(lastBody()).not.toHaveProperty('chatSignalsNotice');
        expect(lastBody()).not.toHaveProperty('chatSignalsOptOut');
    });

    it('adds chatSignalsOptOut once the visitor ticks "Don\'t count my messages"', async () => {
        const user = userEvent.setup();
        renderEmbed();
        await user.click(await screen.findByRole('checkbox', { name: "Don't count my messages" }));
        await send('Hello');
        expect(lastBody()).toMatchObject({ chatSignalsNotice: `agent_public@${VERSION}`, chatSignalsOptOut: true });
    });
});

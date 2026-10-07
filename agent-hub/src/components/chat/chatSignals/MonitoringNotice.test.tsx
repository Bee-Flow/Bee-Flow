import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { queryWrapper } from '../../../test/queryWrapper';
import type { ChatSignalsTurnSurface } from '../../../hooks/useChatEngine/turnEndpoint';
import MonitoringNotice from './MonitoringNotice';
import useChatSignals from './useChatSignals';

/**
 * The line under the composer, wired the way the chat wires it: the shield
 * status decides whether there is a notice, the preference route holds the
 * person's own choice. Network answers come from a spy on fetch, the one
 * thing authFetch reaches.
 */

const VERSION = '2026-10-14T09:00:00.000Z';
const SHIELD = {
    enabled: true, source: 'org', action: 'redact', failMode: 'fail_closed',
    guardReachable: true, euMode: false, coworkEnabled: false,
};

let chatMonitoring: Record<string, unknown>;
let counted: boolean;
let failPut: boolean;
let fetchSpy: MockInstance<typeof fetch>;

const reply = (body: unknown, status = 200) => ({ ok: status < 300, status, json: async () => body }) as unknown as Response;

beforeEach(() => {
    chatMonitoring = {
        state: 'on', from: '2026-10-14', version: VERSION, surfaces: ['direct'], signals: ['outcomes'],
        noticeUrl: 'https://intranet.example.org/chat-signals',
    };
    counted = true;
    failPut = false;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.includes('/api/privacy/shield-status')) return reply({ ...SHIELD, chatMonitoring });
        if (url.includes('/api/privacy/chat-signals/preference')) {
            if (init?.method === 'PUT') {
                if (failPut) return reply({ error: 'no' }, 500);
                counted = JSON.parse(String(init.body)).counted;
            }
            return reply({ counted });
        }
        return reply({}, 404);
    });
});
afterEach(() => { fetchSpy.mockRestore(); });

function Harness({ surface }: { surface: ChatSignalsTurnSurface | null }) {
    const signals = useChatSignals({ user: { id: 'u1' }, surface });
    return <MonitoringNotice notice={signals.notice} onCounted={signals.setCounted} />;
}

const renderHarness = (surface: ChatSignalsTurnSurface | null) => render(<Harness surface={surface} />, { wrapper: queryWrapper() });
const puts = () => fetchSpy.mock.calls.filter(([, init]) => init?.method === 'PUT');

describe('MonitoringNotice: shown only where counting happens', () => {
    it('renders the line for a chat type the status lists', async () => {
        renderHarness('direct');
        const line = await screen.findByTestId('chat-signals-line');
        expect(line.textContent).toContain('Your organisation counts how the Privacy Shield handled messages here.');
        expect(line.textContent).toContain('does not keep what you wrote or who wrote it');
    });

    it('renders nothing for a chat type the status does not list, or a path with no chat type', async () => {
        const { unmount } = renderHarness('agent');
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        expect(screen.queryByTestId('chat-signals-line')).toBeNull();
        unmount();
        renderHarness(null);
        await waitFor(() => expect(fetchSpy.mock.calls.length).toBeGreaterThan(1));
        expect(screen.queryByTestId('chat-signals-line')).toBeNull();
    });

    it('renders nothing while chat signals are off', async () => {
        chatMonitoring = { state: 'off' };
        renderHarness('direct');
        await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
        expect(screen.queryByTestId('chat-signals-line')).toBeNull();
    });

    it('names the start date while scheduled, and the kinds when they are counted', async () => {
        chatMonitoring = { ...chatMonitoring, state: 'scheduled', signals: ['outcomes', 'kinds'] };
        renderHarness('direct');
        const line = await screen.findByTestId('chat-signals-line');
        expect(line.textContent).toContain('From 14 October 2026, your organisation counts');
        expect(line.textContent).toContain('which kinds of personal data it found');
    });
});

describe('MonitoringNotice: the look and the link', () => {
    it('is neutral: no green, no lock, no "anonymous"', async () => {
        renderHarness('direct');
        const line = await screen.findByTestId('chat-signals-line');
        expect(line.className).toContain('text-[var(--text-tertiary)]');
        expect(line.outerHTML).not.toMatch(/green|success|lock/i);
        expect(line.querySelector('svg')).toBeNull();
        expect(line.textContent).not.toMatch(/anonym/i);
    });

    it('opens the organisation\'s notice in a new tab without an opener', async () => {
        renderHarness('direct');
        const link = await screen.findByTestId('chat-signals-notice-link');
        expect(link.getAttribute('href')).toBe('https://intranet.example.org/chat-signals');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    });
});

describe('MonitoringNotice: "Don\'t count my chat turns"', () => {
    it('PUTs counted:false and switches the line, and "Count them again" PUTs counted:true', async () => {
        const user = userEvent.setup();
        renderHarness('direct');
        await user.click(await screen.findByRole('button', { name: "Don't count my chat turns" }));
        await waitFor(() => expect(screen.getByTestId('chat-signals-line').textContent).toContain('Your chat turns are not counted.'));
        expect(JSON.parse(String(puts()[0][1]?.body))).toEqual({ counted: false });
        expect(String(puts()[0][0])).toContain('/api/privacy/chat-signals/preference');

        await user.click(screen.getByRole('button', { name: 'Count them again' }));
        await waitFor(() => expect(screen.getByTestId('chat-signals-line').textContent).toContain('Your organisation counts'));
        expect(JSON.parse(String(puts()[1][1]?.body))).toEqual({ counted: true });
    });

    it('says so when the choice could not be saved, and keeps the line as it was', async () => {
        failPut = true;
        const user = userEvent.setup();
        renderHarness('direct');
        await user.click(await screen.findByRole('button', { name: "Don't count my chat turns" }));
        expect((await screen.findByTestId('chat-signals-error')).textContent).toBe('Could not save your choice. Try again.');
        expect(screen.getByTestId('chat-signals-line').textContent).toContain('Your organisation counts');
    });

    it('a stored objection shows as "not counted" from the first paint of the line', async () => {
        counted = false;
        renderHarness('direct');
        await waitFor(() => expect(screen.getByTestId('chat-signals-line').textContent).toContain('Your chat turns are not counted.'));
    });
});

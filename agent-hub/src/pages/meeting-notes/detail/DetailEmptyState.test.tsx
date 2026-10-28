import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import { CaptureProvider, useCapture } from '../capture/CaptureContext';
import DetailEmptyState from './DetailEmptyState';

type Connections = { teams?: boolean; googleConnected?: boolean; meetScopesGranted?: boolean };

// The real hooks and the real capture context; only the network answer is faked.
function stubSettings({ teams = false, googleConnected = false, meetScopesGranted = false }: Connections) {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
        const u = String(url);
        const body = u.includes('/api/teams-notes-settings/')
            ? { connection: { microsoftConnected: teams } }
            : u.includes('/api/gmeet-notes-settings/')
                ? { connection: { googleConnected, meetScopesGranted } }
                : {};
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
}

function Mode() {
    const { open, mode } = useCapture();
    return <div data-testid="mode">{open ? String(mode) : 'closed'}</div>;
}

function renderEmpty() {
    render(withQueryClient(<CaptureProvider><DetailEmptyState /><Mode /></CaptureProvider>));
}

describe('DetailEmptyState import buttons', () => {
    beforeEach(cleanup);
    afterEach(() => vi.unstubAllGlobals());

    it('offers only Record and Upload when nothing is connected', async () => {
        stubSettings({});
        renderEmpty();
        expect(screen.getByRole('button', { name: 'Record' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Upload' })).toBeInTheDocument();
        await new Promise((r) => setTimeout(r, 50));
        expect(screen.queryByRole('button', { name: 'Microsoft Teams' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Google Meet' })).toBeNull();
    });

    it('opens the Teams capture flow when Microsoft 365 is connected', async () => {
        stubSettings({ teams: true });
        renderEmpty();
        await userEvent.click(await screen.findByRole('button', { name: 'Microsoft Teams' }));
        expect(screen.getByTestId('mode')).toHaveTextContent('teams');
        expect(screen.queryByRole('button', { name: 'Google Meet' })).toBeNull();
    });

    it('opens the Meet capture flow when connected, or when it needs re-consent', async () => {
        stubSettings({ googleConnected: true, meetScopesGranted: false });
        renderEmpty();
        await userEvent.click(await screen.findByRole('button', { name: 'Google Meet' }));
        expect(screen.getByTestId('mode')).toHaveTextContent('gmeet');
        expect(screen.queryByRole('button', { name: 'Microsoft Teams' })).toBeNull();
    });
});

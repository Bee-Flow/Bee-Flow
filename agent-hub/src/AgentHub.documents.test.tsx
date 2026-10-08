import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AgentHub from './AgentHub';
import { withQueryClient } from './test/queryWrapper';
import { authFetch } from './utils/helpers';
import scopedStorage from './utils/scopedStorage';

vi.mock('./utils/helpers', async (importOriginal) => ({
    ...await importOriginal<typeof import('./utils/helpers')>(), authFetch: vi.fn(),
}));
vi.mock('./components/licensing/LicenseContext', () => ({
    useLicenseContext: () => ({ hasFeature: () => true, hasTier: () => true, tier: 'full' }),
    RequireTier: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('./pages/documents/DocumentsPage', () => ({
    default: ({ mode, initialDocumentId, onDocumentChange }: { mode: string; initialDocumentId: string; onDocumentChange: (id: string | null) => void }) => (
        <div data-testid="documents-page-stub">
            {mode} {initialDocumentId}
            <button onClick={() => onDocumentChange('notebook/n2')}>open notebook</button>
            <button onClick={() => onDocumentChange(null)}>library</button>
        </div>
    ),
}));

const Hub = AgentHub as unknown as React.ComponentType<Record<string, unknown>>;
const MEMBER = { id: 'member', username: 'member', permissions: ['page_chat'], orgRole: 'member' };

beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/app/documents/notebook/n1');
    vi.mocked(authFetch).mockResolvedValue({
        ok: true, status: 200, headers: { get: () => 'application/json' },
        json: async () => [], text: async () => '[]',
    } as unknown as Response);
});

describe('AgentHub — member documents', () => {
    it('keeps the ordinary sidebar and document navigation for a member without builder rights', async () => {
        const onNavigate = vi.fn();
        render(withQueryClient(<Hub user={MEMBER} currentPage="documents" initialDocumentId="notebook/n1" onNavigate={onNavigate} />));
        expect(await screen.findByTestId('documents-page-stub')).toHaveTextContent('workspace notebook/n1');
        expect(screen.getByTestId('nav-documents')).toHaveAttribute('aria-current', 'page');
        expect(screen.getByTestId('nav-new-chat')).toBeInTheDocument();
        expect(screen.queryByTestId('nav-studio')).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'open notebook' }));
        expect(onNavigate).toHaveBeenCalledWith('documents/notebook/n2');
        await userEvent.click(screen.getByRole('button', { name: 'library' }));
        expect(onNavigate).toHaveBeenLastCalledWith('documents');
    });

    it('can leave documents to start a chat', async () => {
        const onNavigate = vi.fn();
        render(withQueryClient(<Hub user={MEMBER} currentPage="documents" onNavigate={onNavigate} />));
        await screen.findByTestId('documents-page-stub');
        await userEvent.click(screen.getByTestId('nav-new-chat'));
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('agents'));
    });

    it('preserves a bookmarked document while the preferred agent initializes', async () => {
        scopedStorage.setCurrentUser(MEMBER.id);
        scopedStorage.setItem('defaultAgentMode', 'specific');
        scopedStorage.setItem('defaultAgentId', 'default-agent');
        vi.mocked(authFetch).mockImplementation(async (url) => ({
            ok: true, status: 200, headers: { get: () => 'application/json' },
            json: async () => /\/agents(?:\/published)?\?/.test(String(url)) ? [{ id: 'default-agent', name: 'Default agent' }] : [],
            text: async () => '[]',
        } as unknown as Response));
        render(withQueryClient(<Hub user={MEMBER} currentPage="documents" initialDocumentId="notebook/n1" onNavigate={vi.fn()} />));
        await screen.findByTestId('documents-page-stub');
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith(expect.stringContaining('/agents/default-agent/conversations')));
        expect(window.location.pathname).toBe('/app/documents/notebook/n1');
    });
});

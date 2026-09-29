import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playbooksApi } from './playbooksApi';
import PlaybooksStudio from './PlaybooksStudio';

vi.mock('./playbooksApi', () => {
    const playbooksApi = { list: vi.fn(), get: vi.fn(), create: vi.fn(), patch: vi.fn(), runPhase: vi.fn(), skipPhase: vi.fn(), retryPhase: vi.fn(), remove: vi.fn(), recipes: vi.fn() };
    return { playbooksApi, default: playbooksApi };
});
vi.mock('./PlaybookRun', () => ({ default: ({ playbookId, onBack }) => <div data-testid="playbook-run" data-id={playbookId}><button type="button" onClick={onBack}>back</button></div> }));
vi.mock('./NewPlaybookDialog', () => ({ default: ({ onCreated, onClose }) => (
    <div data-testid="new-playbook-dialog">
        <button type="button" onClick={() => onCreated({ id: 'pb_new', title: 'Nieuw', recipeId: 'invoice_tracker', status: 'active', phases: [] })}>create</button>
        <button type="button" onClick={onClose}>close</button>
    </div>
) }));

const ROWS = [
    { id: 'pb_1', title: 'Facturen bijhouden', recipeId: 'invoice_tracker', recipeLabel: 'Invoice tracker', status: 'active', currentPhase: 'routine', progress: { done: 1, total: 5 }, phases: [{ key: 'table', status: 'done' }, { key: 'routine', status: 'awaiting' }], updatedAt: new Date().toISOString() },
    { id: 'pb_2', title: 'Oude', recipeId: 'invoice_tracker', recipeLabel: 'Invoice tracker', status: 'stopped', progress: { done: 3, total: 5 }, phases: [] },
];

beforeEach(() => { vi.resetAllMocks(); playbooksApi.list.mockResolvedValue({ playbooks: ROWS }); });
afterEach(() => cleanup());

describe('PlaybooksStudio — the list and its doors', () => {
    it('lists the playbooks with progress and a status word; a card opens the run and flips the editing flag', async () => {
        const onEditingChange = vi.fn();
        const onNavigate = vi.fn();
        render(<PlaybooksStudio user={{ id: 'u1' }} onNavigate={onNavigate} onEditingChange={onEditingChange} />);
        const card = await screen.findByTestId('playbook-card-pb_1');
        expect(card.textContent).toContain('1/5 phases');
        expect(card.textContent).toContain('Paused for you');
        expect(screen.getByTestId('playbook-card-pb_2').textContent).toContain('Stopped');
        expect(onEditingChange).toHaveBeenLastCalledWith(false);
        fireEvent.click(card);
        expect(screen.getByTestId('playbook-run').getAttribute('data-id')).toBe('pb_1');
        expect(onNavigate).toHaveBeenLastCalledWith('studio/playbooks/pb_1');
        expect(onEditingChange).toHaveBeenLastCalledWith(true);
        fireEvent.click(screen.getByText('back'));
        expect(screen.queryByTestId('playbook-run')).toBeNull();
        expect(onNavigate).toHaveBeenLastCalledWith('studio/playbooks');
        await waitFor(() => expect(playbooksApi.list).toHaveBeenCalledTimes(2));
    });

    it('empty state offers New only to who may build; the deep link "new" opens the dialog and a created playbook opens at once', async () => {
        playbooksApi.list.mockResolvedValue({ playbooks: [] });
        const { unmount } = render(<PlaybooksStudio user={{ id: 'u1' }} hasPermission={() => false} />);
        expect(await screen.findByText('No playbooks yet')).toBeTruthy();
        expect(screen.queryByText('New playbook')).toBeNull();
        unmount();

        const onNavigate = vi.fn();
        render(<PlaybooksStudio user={{ id: 'u1' }} initialPlaybookId="new" onNavigate={onNavigate} />);
        expect(await screen.findByTestId('new-playbook-dialog')).toBeTruthy();
        fireEvent.click(screen.getByText('create'));
        expect(screen.getByTestId('playbook-run').getAttribute('data-id')).toBe('pb_new');
        expect(onNavigate).toHaveBeenLastCalledWith('studio/playbooks/pb_new');
    });

    it('adopts a changed deep link — including back to null', async () => {
        const { rerender } = render(<PlaybooksStudio user={{ id: 'u1' }} initialPlaybookId="pb_1" />);
        expect(screen.getByTestId('playbook-run').getAttribute('data-id')).toBe('pb_1');
        rerender(<PlaybooksStudio user={{ id: 'u1' }} initialPlaybookId="pb_2" />);
        expect(screen.getByTestId('playbook-run').getAttribute('data-id')).toBe('pb_2');
        rerender(<PlaybooksStudio user={{ id: 'u1' }} initialPlaybookId={null} />);
        expect(screen.queryByTestId('playbook-run')).toBeNull();
        expect(await screen.findByTestId('playbook-card-pb_1')).toBeTruthy();
    });
});

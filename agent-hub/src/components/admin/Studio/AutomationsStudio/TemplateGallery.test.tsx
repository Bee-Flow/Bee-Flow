import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../icons/AppIcon', () => ({ default: () => null }));

import { authFetch } from '../../../../utils/helpers';
import TemplateGallery from './TemplateGallery';

const fetchMock = vi.mocked(authFetch);
const json = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

const tmpl = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: `Template ${id}`, description: `Does ${id}.`, category: 'Files', source: 'builtin',
    tags: [], requiredIntegrations: [], triggerKind: 'schedule', stepCount: 3, ...over,
});

function renderGallery(templates: unknown[], onPick = vi.fn()) {
    fetchMock.mockResolvedValue(json({ templates, categories: ['Files'] }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={client}>
            <TemplateGallery onPick={onPick} />
        </QueryClientProvider>,
    );
    return { onPick };
}

const cardOf = (title: string) => screen.getByText(title).closest('[data-testid="template-card"]') as HTMLElement;

describe('TemplateGallery', () => {
    beforeEach(() => fetchMock.mockReset());
    afterEach(cleanup);

    it('explains itself in one line and reads GET /api/automation/templates', async () => {
        renderGallery([tmpl('a')]);
        expect(screen.getByRole('heading', { name: 'Templates' })).toBeTruthy();
        expect(await screen.findByText('Template a')).toBeTruthy();
        expect(String(fetchMock.mock.calls[0][0])).toBe('/api/automation/templates');
    });

    it('leads with "Your organisation", saying who saved each one', async () => {
        const user = userEvent.setup();
        const { onPick } = renderGallery([
            tmpl('ours', { source: 'org', category: null, createdByName: 'Anne de Vries', mine: false, createdAt: new Date().toISOString() }),
            tmpl('mine', { source: 'org', category: null, mine: true }),
            tmpl('builtin'),
        ]);
        const org = await screen.findByTestId('templates-org');
        const builtIn = screen.getByTestId('templates-builtin');
        expect(org.compareDocumentPosition(builtIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(within(org).getByText('Your organisation')).toBeTruthy();
        expect(within(builtIn).getByText('Bee Flow templates')).toBeTruthy();
        expect(within(cardOf('Template ours')).getByText(/Saved by Anne de Vries · just now/)).toBeTruthy();
        expect(within(cardOf('Template mine')).getByText('Saved by you')).toBeTruthy();
        expect(within(cardOf('Template builtin')).queryByText(/Saved by/)).toBeNull();

        await user.click(within(cardOf('Template ours')).getByRole('button', { name: 'Use template' }));
        expect(onPick).toHaveBeenCalledWith('ours', expect.objectContaining({ source: 'org' }));
    });

    it('without organisation templates it says how to save one', async () => {
        renderGallery([tmpl('a')]);
        const empty = await screen.findByTestId('templates-org-empty');
        expect(empty.textContent).toMatch(/Settings → General → Save as template/);
    });

    it('each card has a quiet "starts with" line and one primary "Use template"', async () => {
        renderGallery([
            tmpl('sched'),
            tmpl('nc', { triggerKind: 'app_event', triggerApp: 'nextcloud', stepCount: 1, triggerReadiness: 'push-pending' }),
        ]);
        await screen.findByText('Template sched');
        expect(within(cardOf('Template sched')).getByText('Starts on a schedule · 3 steps')).toBeTruthy();
        expect(within(cardOf('Template nc')).getByText('Starts when something happens in Nextcloud · 1 step · needs the Bee Flow connector')).toBeTruthy();
        const buttons = within(cardOf('Template sched')).getAllByRole('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].className).toContain('bg-[var(--accent-primary)]');
    });

    it('category chips come from the templates, and narrow the list', async () => {
        const user = userEvent.setup();
        renderGallery([
            tmpl('f1'), tmpl('f2'),
            tmpl('c1', { category: 'Calendar' }),
            tmpl('ours', { source: 'org', category: null }),
        ]);
        await screen.findByText('Template f1');
        const chips = screen.getByRole('group', { name: 'Categories' });
        expect(within(chips).getAllByRole('button').map(b => b.textContent)).toEqual(['All4', 'Files2', 'Calendar1']);
        await user.click(within(chips).getByRole('button', { name: /Calendar/ }));
        expect(screen.getByText('Template c1')).toBeTruthy();
        expect(screen.queryByText('Template f1')).toBeNull();
        // An organisation template has no category, so its section steps aside.
        expect(screen.queryByTestId('templates-org')).toBeNull();
    });

    it('search reads titles, sentences and tags; no match says so and offers a way back', async () => {
        const user = userEvent.setup();
        renderGallery([tmpl('invoices', { tags: ['gmail'] }), tmpl('meetings')]);
        await screen.findByText('Template invoices');
        await user.type(screen.getByRole('searchbox', { name: 'Search templates' }), 'gmail');
        expect(screen.getByText('Template invoices')).toBeTruthy();
        expect(screen.queryByText('Template meetings')).toBeNull();
        await user.clear(screen.getByRole('searchbox', { name: 'Search templates' }));
        await user.type(screen.getByRole('searchbox', { name: 'Search templates' }), 'zzz');
        expect(screen.getByText('No template matches.')).toBeTruthy();
        await user.click(screen.getAllByRole('button', { name: 'Clear the search' })[0]);
        expect(screen.getByText('Template meetings')).toBeTruthy();
    });

    it('a failed read says so in a sentence, never in the server\'s words, with a way to try again', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue(json({ error: 'Not found' }, 404));
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
            <QueryClientProvider client={client}>
                <TemplateGallery onPick={vi.fn()} />
            </QueryClientProvider>,
        );
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/The templates could not be loaded\./);
        expect(alert.textContent).not.toMatch(/Not found/);
        fetchMock.mockResolvedValue(json({ templates: [tmpl('back')] }));
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Template back')).toBeTruthy();
    });

    it('a failed refetch keeps the templates already on screen', async () => {
        fetchMock.mockResolvedValue(json({ templates: [tmpl('kept')] }));
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
            <QueryClientProvider client={client}>
                <TemplateGallery onPick={vi.fn()} />
            </QueryClientProvider>,
        );
        expect(await screen.findByText('Template kept')).toBeTruthy();
        fetchMock.mockResolvedValue(json({ error: 'Not found' }, 404));
        await act(() => client.refetchQueries());
        expect(screen.getByText('Template kept')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });
});

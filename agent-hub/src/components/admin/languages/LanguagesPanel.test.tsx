import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { renderWithClient } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LanguagesPanel from './LanguagesPanel';
import { authFetch } from '@/utils/helpers';

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

const fetchMock = vi.mocked(authFetch);
const json = (body: unknown) => ({ ok: true, json: async () => body }) as unknown as Response;

beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
        if (url === '/api/languages') {
            return json({
                locales: [{ code: 'en', name: 'English', isDefault: true }, { code: 'nl', name: 'Nederlands' }],
                catalog: [{ code: 'de', name: 'Deutsch' }],
            });
        }
        if (url === '/api/languages/nl/gui' && opts?.method === 'PATCH') {
            return json({ translations: { 'chat.send': 'Verstuur' } });
        }
        if (url === '/api/languages/nl/gui') {
            return json({
                defaults: { 'chat.send': 'Send', 'chat.stop': 'Stop' },
                translations: {},
                namespaces: ['chat'],
                stats: { translated: 0, total: 2, missing: 2, progress: 0 },
            });
        }
        return json({});
    });
});
afterEach(cleanup);

describe('LanguagesPanel', () => {
    it('opens the first non-English locale and saves an inline GUI translation on blur', async () => {
        const user = userEvent.setup();
        renderWithClient(<LanguagesPanel />);
        expect(await screen.findByText('chat.send')).toBeTruthy();
        expect(screen.getByText('0 / 2 (0%)')).toBeTruthy();
        const input = screen.getByPlaceholderText('Send');
        await user.type(input, 'Verstuur');
        await user.tab();
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/languages/nl/gui', expect.objectContaining({ method: 'PATCH' })));
        const patch = fetchMock.mock.calls.find(([, o]) => (o as RequestInit | undefined)?.method === 'PATCH');
        expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ updates: { 'chat.send': 'Verstuur' } });
    });

    it('filters the keys and lists only catalogue languages that are not installed', async () => {
        const user = userEvent.setup();
        renderWithClient(<LanguagesPanel />);
        await user.type(await screen.findByPlaceholderText('Search keys or values...'), 'stop');
        expect(screen.queryByText('chat.send')).toBeNull();
        expect(screen.getByText('chat.stop')).toBeTruthy();
        await user.click(screen.getByTitle('Add language'));
        expect(screen.getByText('Deutsch')).toBeTruthy();
        const dialog = screen.getByRole('dialog');
        expect(within(dialog).queryByRole('button', { name: /Nederlands/ })).toBeNull();
    });

    it('lists the locales in a navigation, marks the open one, and shows its sections as tabs', async () => {
        const user = userEvent.setup();
        renderWithClient(<LanguagesPanel />);
        const nav = await screen.findByRole('navigation', { name: 'Languages' });
        expect(within(nav).getByRole('button', { name: /Nederlands/ })).toHaveAttribute('aria-current', 'page');
        expect(within(nav).getByRole('button', { name: /English/ })).not.toHaveAttribute('aria-current');
        expect(screen.getByRole('tab', { name: 'GUI Translations' })).toHaveAttribute('aria-selected', 'true');
        await user.click(screen.getByRole('tab', { name: 'Prompt translations' }));
        expect(screen.getByRole('tab', { name: 'Prompt translations' })).toHaveAttribute('aria-selected', 'true');
    });

    it('offers Export and Import once, in the header of the open locale, not on the locale rows', async () => {
        renderWithClient(<LanguagesPanel />);
        const nav = await screen.findByRole('navigation', { name: 'Languages' });
        expect(within(nav).queryByRole('button', { name: 'Export' })).toBeNull();
        expect(within(nav).queryByRole('button', { name: 'Import' })).toBeNull();
        expect(within(nav).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /Export/ })).toHaveLength(1);
        expect(screen.getAllByRole('button', { name: /Import/ })).toHaveLength(1);
    });

    it('opens the locale and section the address names, and writes a pick into the address', async () => {
        const user = userEvent.setup();
        const onNavigate = vi.fn();
        renderWithClient(<LanguagesPanel locale="en" section="prompts" onNavigate={onNavigate} />);
        const nav = await screen.findByRole('navigation', { name: 'Languages' });
        expect(within(nav).getByRole('button', { name: /English/ })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('tab', { name: 'Prompt translations' })).toHaveAttribute('aria-selected', 'true');

        await user.click(within(nav).getByRole('button', { name: /Nederlands/ }));
        expect(onNavigate).toHaveBeenLastCalledWith('admin/languages/nl/prompts');
        await user.click(screen.getByRole('tab', { name: 'Email Templates' }));
        expect(onNavigate).toHaveBeenLastCalledWith('admin/languages/en/emails');
    });

    it('sets the language new users start in for the whole server, and says it was saved', async () => {
        const user = userEvent.setup();
        renderWithClient(<LanguagesPanel />);
        const select = await screen.findByRole('combobox', { name: 'New users start in' });
        expect(select).toHaveValue('en');
        await user.selectOptions(select, 'nl');
        await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/languages/org/default', expect.objectContaining({ method: 'PUT' })));
        const put = fetchMock.mock.calls.find(([u, o]) => u === '/api/languages/org/default' && (o as RequestInit | undefined)?.method === 'PUT');
        expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({ defaultLocale: 'nl' });
        expect(await within(screen.getByTestId('new-user-language')).findByText(/Saved/)).toBeInTheDocument();
    });
});

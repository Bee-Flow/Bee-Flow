import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderWithClient } from '../../../test/render';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LanguagesPanel from './LanguagesPanel';
import { authFetch } from '../../../utils/helpers';

vi.mock('../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

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
        expect(screen.queryByRole('button', { name: /Nederlands/ })).toBeNull();
    });
});

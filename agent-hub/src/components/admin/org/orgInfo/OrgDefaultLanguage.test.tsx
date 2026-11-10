/**
 * The default language of new users is ONE value for the whole server, and the
 * server lets only a platform administrator set it. An organisation admin
 * reads it; nobody is offered a control that would come back 403.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import OrgDefaultLanguage from './OrgDefaultLanguage';
import { withQueryClient } from '@/test/render';

const LANGUAGES = { defaultLocale: 'nl', locales: [{ code: 'en', name: 'English' }, { code: 'nl', name: 'Nederlands' }] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchSpy: MockInstance<typeof fetch>;
const puts = () => fetchSpy.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PUT');

beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => (
        (init as RequestInit | undefined)?.method === 'PUT' ? json({ defaultLocale: 'en' }) : json(LANGUAGES)
    ));
});
afterEach(() => { fetchSpy.mockRestore(); });

describe('OrgDefaultLanguage', () => {
    it('shows an organisation admin the current default, with no control and no request to change it', async () => {
        render(withQueryClient(<OrgDefaultLanguage canEdit={false} />));

        expect(await screen.findByRole('heading', { name: 'Default Language' })).toBeInTheDocument();
        expect(screen.getByText('New User Language')).toBeInTheDocument();
        expect(screen.getByText('Nederlands')).toBeInTheDocument();
        expect(screen.getByText('This applies to the whole server. Only a platform administrator can change it.')).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).toBeNull();
        expect(screen.queryByRole('button')).toBeNull();
        expect(screen.queryByText('English')).toBeNull();
        expect(puts()).toHaveLength(0);
    });

    it('is read-only unless it is told the user is a platform administrator', async () => {
        render(withQueryClient(<OrgDefaultLanguage />));
        expect(await screen.findByText('Nederlands')).toBeInTheDocument();
        expect(screen.queryByRole('combobox')).toBeNull();
    });

    it('lets a platform administrator pick, and saves the pick at once', async () => {
        const user = userEvent.setup();
        render(withQueryClient(<OrgDefaultLanguage canEdit />));

        const select = await screen.findByRole('combobox', { name: 'New User Language' });
        expect(select).toHaveValue('nl');
        expect(screen.queryByText('This applies to the whole server. Only a platform administrator can change it.')).toBeNull();

        await user.selectOptions(select, 'English');
        await waitFor(() => expect(puts()).toHaveLength(1));
        expect(String(puts()[0][0])).toContain('/api/languages/org/default');
        expect(JSON.parse(String((puts()[0][1] as RequestInit).body))).toEqual({ defaultLocale: 'en' });
        expect(await screen.findByText('Saved')).toBeInTheDocument();
    });
});

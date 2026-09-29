import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The language Bee writes the proposal in, as the card sends it.
const sent: Array<string | null | undefined> = [];
vi.mock('../../../../api/queries/automation/settings', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../../../api/queries/automation/settings')>();
    return {
        ...real,
        useSuggestDescriptionMutation: (language?: string | null) => ({
            isPending: false, isError: false, error: null,
            mutate: (_id: string, opts?: { onSuccess?: (text: string) => void }) => { sent.push(language); opts?.onSuccess?.('A proposal.'); },
        }),
    };
});

// A person whose preference is Dutch (the browser, or Nextcloud handed it
// over); `strings` is the Dutch catalogue the deployment actually loaded.
let catalogue: Record<string, string> = {};
vi.mock('../../../../hooks/useTranslation', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../../../hooks/useTranslation')>();
    return {
        ...real,
        useTranslation: () => ({
            t: (key: string, fallback?: unknown) => catalogue[key] ?? (typeof fallback === 'string' ? fallback : key),
            locale: 'nl', resolvedLocale: 'nl', strings: catalogue, setLocale: () => {}, isLoading: false,
        }),
    };
});

import DescriptionSuggestion from './DescriptionSuggestion';

function ask() {
    render(
        <QueryClientProvider client={new QueryClient()}>
            <DescriptionSuggestion automationId="a1" onAccept={() => {}} onEdit={() => {}} />
        </QueryClientProvider>,
    );
    return userEvent.setup().click(screen.getByRole('button'));
}

afterEach(() => { cleanup(); sent.length = 0; catalogue = {}; });

describe('the description Bee suggests is in the language on screen', () => {
    it('an English screen gets an English proposal, even with a Dutch preference', async () => {
        // A Dutch catalogue is loaded, but it does not cover this card: the
        // screen falls back to English, so Bee writes English.
        catalogue = { 'common.save': 'Opslaan' };
        await ask();
        await screen.findByText('A proposal.');
        expect(sent).toEqual(['en']);
    });

    it('a Dutch screen gets a Dutch proposal', async () => {
        catalogue = {
            'routines.settings.suggest_link': 'Laat Bee een beschrijving voorstellen op basis van de stappen',
            'routines.settings.suggest_title': 'Voorstel van Bee',
            'routines.settings.suggest_accept': 'Overnemen',
        };
        await ask();
        await screen.findByText('A proposal.');
        expect(sent).toEqual(['nl']);
    });
});

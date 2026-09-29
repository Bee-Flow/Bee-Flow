/**
 * CoworkPage — the strings the page owns, under a translator that ECHOES THE
 * KEY and throws the English fallback away.
 *
 * Two blocks on this page were walked past by the retrofit and are pinned
 * here:
 *
 *   - the DELETE confirmation. It is the one destructive dialog in Cowork, and
 *     it was the one block left entirely in English — heading, consequence,
 *     both buttons. The consequence sentence was also assembled out of JSX
 *     fragments with the title as a child between them, which cannot become
 *     one key at all: the title travels as a parameter now.
 *   - the STARTERS. The four sentences live in CoworkWelcome as {key, en}
 *     pairs, but this page imported the flattened `COWORK_STARTERS` array of
 *     strings, which drops the keys. The same four sentences therefore showed
 *     as English here and as their translation on the chat welcome screen,
 *     out of one file.
 *
 * See cowork.i18n.test.jsx for why an echoing translator is what makes these
 * bite: paste a literal back into the JSX and the English reappears.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const echoT = (key, _english, params) => (params
    ? `«${key}»${JSON.stringify(params)}`
    : `«${key}»`);
vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t: echoT, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t: echoT, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }) => children,
}));

const api = vi.hoisted(() => ({
    listCowork: vi.fn(),
    createCowork: vi.fn(),
    updateCowork: vi.fn(),
    toggleCowork: vi.fn(),
    runCoworkNow: vi.fn(),
    deleteCowork: vi.fn(),
    composeCowork: vi.fn(),
    listCoworkRuns: vi.fn(),
    listCoworkAgents: vi.fn(),
}));
vi.mock('./coworkApi', () => api);
vi.mock('../licensing/EntitlementsContext', () => ({
    useEntitlements: () => ({ loading: false, can: () => false }),
}));
vi.mock('../../hooks/useIntegrationStatus', () => ({
    useIntegrationStatus: () => ({
        integrationStatus: { isGoogleUser: true, enabledApps: null, orgEnabledIntegrations: null },
        unavailable: false,
    }),
}));
vi.mock('../../hooks/useModelTierSelection', () => ({
    default: () => ({ modelTiers: null, selectedTier: 'auto', setSelectedTier: vi.fn() }),
}));

const CoworkPage = (await import('./CoworkPage')).default;

const ITEM = {
    id: 'w1',
    title: 'Weekly digest',
    prompt: 'Summarise the week',
    isActive: true,
    lastStatus: 'success',
    lastRunAt: new Date().toISOString(),
    repeatInterval: 'weekly',
    runCount: 3,
};

function seed(items = []) {
    api.listCowork.mockResolvedValue({ items, maxItems: 10 });
    api.listCoworkRuns.mockResolvedValue({ runs: [], total: 0 });
    api.listCoworkAgents.mockResolvedValue([]);
}

beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
});

describe('CoworkPage — the delete confirmation', () => {
    async function openConfirm() {
        seed([ITEM]);
        render(<CoworkPage />);
        fireEvent.click(await screen.findByTestId('cowork-row'));
        fireEvent.click(await screen.findByTestId('cowork-delete'));
        return screen.findByTestId('cowork-confirm-delete');
    }

    it('asks the question through t(), buttons and all', async () => {
        const confirmButton = await openConfirm();
        const dialog = confirmButton.closest('div.rounded-2xl');
        expect(dialog.textContent).toContain('«cowork.delete.heading»');
        expect(dialog.textContent).toContain('«cowork.delete.cancel»');
        expect(dialog.textContent).toContain('«cowork.delete.confirm»');
        expect(dialog.textContent).not.toMatch(/Delete this cowork\?|Cancel|^Delete$/);
    });

    it('hands the title to the sentence as a parameter, not as a fragment', async () => {
        // Glued between two JSX fragments the sentence cannot be translated at
        // all: a language that puts the name last has nowhere to put it.
        const confirmButton = await openConfirm();
        const dialog = confirmButton.closest('div.rounded-2xl');
        expect(dialog.textContent).toContain('«cowork.delete.consequence»');
        expect(dialog.textContent).toContain('"title":"Weekly digest"');
        expect(dialog.textContent).not.toContain('stops running and its history is removed');
    });
});

describe('CoworkPage — the starters', () => {
    it('shows the TRANSLATED sentence, the same as the chat welcome does', async () => {
        seed([]);
        render(<CoworkPage />);
        const starters = await screen.findAllByTestId('cowork-starter');
        expect(starters).toHaveLength(4);
        for (const s of starters) {
            expect(s.textContent).toMatch(/^«cowork\.welcome\.starter_/);
        }
        expect(screen.queryByText(/summarise the AI news/i)).not.toBeInTheDocument();
    });

    it('fills the box with the translated sentence, not the English behind it', async () => {
        seed([]);
        render(<CoworkPage />);
        const starters = await screen.findAllByTestId('cowork-starter');
        fireEvent.click(starters[0]);
        await waitFor(() => expect(screen.getByTestId('cowork-brief-input').value)
            .toBe('«cowork.welcome.starter_ai_news»'));
    });
});

describe('CoworkPage — the way back on a phone', () => {
    it('labels the close button through t()', async () => {
        // isMobile is a prop, not a media query: the phone layout is what the
        // shell hands down.
        seed([ITEM]);
        render(<CoworkPage isMobile />);
        fireEvent.click(await screen.findByTestId('cowork-row'));
        expect(await screen.findByLabelText('«cowork.list.back»')).toBeInTheDocument();
        expect(screen.queryByLabelText('Back to the list')).not.toBeInTheDocument();
    });
});

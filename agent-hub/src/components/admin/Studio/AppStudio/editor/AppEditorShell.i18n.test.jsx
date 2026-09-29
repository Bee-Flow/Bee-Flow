import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A TRANSLATED editor shell.
 *
 * AppEditorShell.test.jsx renders the English fallbacks and finds every pane
 * and rail by its English accessible name — which is exactly what it should
 * assert, and what a missing translation still shows. What it therefore
 * cannot see is the failure this file exists for: the shell has no visible
 * text of its own. The AI builder pane, the inspector column and all four
 * collapse/expand controls are reachable ONLY through an aria-label or a
 * title, so a hard-coded English one leaves a Dutch user with an unnamed
 * region and a button no screen reader can announce — and every English
 * assertion in the sibling suite keeps passing while it does.
 *
 * The stub below resolves the shell keys to Dutch and otherwise hands back
 * the call site's own fallback, so the rest of the editor renders exactly as
 * it does in the sibling suite.
 */
// vi.mock's factory is hoisted above every import, so the stub is built inside
// it — a module-scope helper would not exist yet when the first component in
// the tree imports the hook.
vi.mock('../../../../../hooks/useTranslation', () => {
    const NL = {
        'app_studio.shell.ai_builder': 'AI-bouwer',
        'app_studio.shell.ai_building': 'De AI is aan het bouwen — klik om mee te kijken',
        'app_studio.shell.ai_hide': 'Verberg de AI-bouwer',
        'app_studio.shell.ai_resize': 'Breedte van het AI-paneel aanpassen',
        'app_studio.shell.ai_show': 'Toon de AI-bouwer',
        'app_studio.shell.ai_soon': 'AI-assistent — binnenkort',
        // ai_soon_aria is deliberately NOT translated — see the last case.
        'app_studio.shell.inspector': 'Inspecteur',
        'app_studio.shell.inspector_collapse': 'Inspecteur inklappen',
        'app_studio.shell.inspector_resize': 'Breedte van de inspecteur aanpassen',
        'app_studio.shell.inspector_show': 'Inspecteur tonen',
    };
    const t = (key, fallbackOrParams, paramsArg) => {
        const hasFallback = typeof fallbackOrParams === 'string';
        const params = hasFallback ? paramsArg : fallbackOrParams;
        let value = NL[key] ?? (hasFallback ? fallbackOrParams : key);
        if (params && typeof params === 'object') {
            for (const [k, v] of Object.entries(params)) {
                value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
            }
        }
        return value;
    };
    const useTranslation = () => ({ t, locale: 'nl', setLocale: () => { }, isLoading: false, strings: NL });
    return {
        default: useTranslation,
        useTranslation,
        TranslationProvider: ({ children }) => children,
        ensureI18nDefaults: () => Promise.resolve(),
    };
});

// The inspector is a sibling module with its own tests — mock it so this suite
// stays about the shell's own chrome.
vi.mock('../inspector/InspectorPanel', () => ({
    default: () => <div data-testid="inspector-panel" />,
}));

vi.mock('../studioAppsApi', () => {
    const api = {
        saveDefinition: vi.fn().mockResolvedValue({ ok: true, version: 4, warnings: [], repairs: [] }),
        updateApp: vi.fn().mockResolvedValue({}),
        publish: vi.fn().mockResolvedValue({}),
        listVersions: vi.fn().mockResolvedValue({ versions: [] }),
        restoreVersion: vi.fn().mockResolvedValue({}),
        getApp: vi.fn().mockResolvedValue({}),
    };
    return { studioAppsApi: api, default: api };
});

import AppEditorShell from './AppEditorShell';
import { useAppEditor } from '../state/AppEditorContext';
import { KITCHEN_SINK } from '../state/sampleDefinitions';

// The palette reads the session-cached component catalog, so the shell needs
// the QueryClient it always has around it in the app.
const render = (ui) => rtlRender(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {ui}
    </QueryClientProvider>,
);

const app = {
    id: 'app-1',
    name: 'Kitchen sink',
    definition: KITCHEN_SINK,
    version: 3,
    isPublished: false,
};

/** A chat slot that can put the shell into a streaming AI turn. */
function FakeAIPane() {
    const { dispatch } = useAppEditor();
    return (
        <button type="button" onClick={() => dispatch({ type: 'set_stream_lock', streamLock: true })}>
            ai-lock
        </button>
    );
}

describe('AppEditorShell — the translated shell chrome', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    it('names the AI builder pane and its collapse control in the active language', () => {
        render(<AppEditorShell app={app} onClose={vi.fn()} chatSlot={<div data-testid="chat-slot" />} />);

        expect(screen.getByLabelText('AI-bouwer')).toBeInTheDocument();
        expect(screen.getByRole('separator', { name: 'Breedte van het AI-paneel aanpassen' })).toBeInTheDocument();

        // Collapse and reopen through the Dutch names: the affordance is keyed
        // to the button, not to the English string that used to name it.
        fireEvent.click(screen.getByRole('button', { name: 'Verberg de AI-bouwer' }));
        expect(screen.getByLabelText('AI-bouwer')).toHaveClass('hidden');
        fireEvent.click(screen.getByRole('button', { name: 'Toon de AI-bouwer' }));
        expect(screen.getByLabelText('AI-bouwer')).not.toHaveClass('hidden');
    });

    it('translates BOTH titles the collapsed AI rail flips between', () => {
        render(<AppEditorShell app={app} onClose={vi.fn()} chatSlot={<FakeAIPane />} />);

        fireEvent.click(screen.getByRole('button', { name: 'ai-lock' }));
        fireEvent.click(screen.getByRole('button', { name: 'Verberg de AI-bouwer' }));

        // Two keys sit on one button here: the title says the AI is working
        // while the accessible name stays "show". A hard-coded English title
        // on this branch only appears mid-stream, so nothing else looks at it.
        const rail = screen.getByRole('button', { name: 'Toon de AI-bouwer' });
        expect(rail).toHaveAttribute('title', 'De AI is aan het bouwen — klik om mee te kijken');
    });

    it('names the inspector column and its two collapse controls', () => {
        render(<AppEditorShell app={app} onClose={vi.fn()} />);

        expect(screen.getByRole('complementary', { name: 'Inspecteur' })).toBeInTheDocument();
        expect(screen.getByRole('separator', { name: 'Breedte van de inspecteur aanpassen' })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Inspecteur inklappen' }));
        expect(screen.queryByRole('complementary', { name: 'Inspecteur' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Inspecteur tonen' }));
        expect(screen.getByRole('complementary', { name: 'Inspecteur' })).toBeInTheDocument();
    });

    it('falls back to the call site English for a key the catalogue does not have', () => {
        // Without a chatSlot the rail is the "coming soon" placeholder. Its
        // title is translated, its aria-label is not in the stub — an untranslated
        // key must show the English fallback, never the raw key.
        render(<AppEditorShell app={app} onClose={vi.fn()} />);

        const rail = screen.getByLabelText('AI assistant (coming soon)');
        expect(rail).toBeInTheDocument();
        expect(screen.getByTitle('AI-assistent — binnenkort')).toBeInTheDocument();
    });
});

import { DndContext } from '@dnd-kit/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The palette reads the component catalog for its per-card descriptions.
// Stubbed so this suite makes no network call — an unmocked one resolves after
// the test ends and logs through a closed worker channel.
vi.mock('../studioAppsApi', () => ({
    studioAppsApi: { getCatalog: vi.fn().mockResolvedValue({ components: {} }) },
}));

/**
 * A translated tab strip. ComponentRibbon.test.jsx renders the ENGLISH
 * fallbacks — which is what the rest of the suite asserts on, and what a
 * missing translation still shows — so the one thing it cannot see is the
 * split this file exists for: the group names are IDS as well as labels.
 * "Start here", "All" and every PALETTE_CATEGORIES entry are persisted under
 * `appStudioRibbonTab` and matched against `entry.category`; translating the
 * id along with the label would empty the strip in every language but English,
 * and no English-only test can tell the two apart.
 *
 * The stub resolves the three keys below and otherwise returns the call site's
 * own fallback, so every other string in the ribbon renders exactly as it does
 * in the rest of the suite.
 */
// vi.mock's factory is hoisted above every import, so the stub is built
// inside it — a module-scope helper would not exist yet when the first
// component in the tree imports the hook.
vi.mock('../../../../../hooks/useTranslation', () => {
    const NL = {
        'app_studio.palette.tab_start_here': 'Begin hier',
        'app_studio.palette.tab_all': 'Alles',
        'app_studio.palette.data': 'Gegevens',
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

import ComponentRibbon from './ComponentRibbon';
import { AppEditorProvider } from '../state/AppEditorContext';
import { KITCHEN_SINK } from '../state/sampleDefinitions';
import * as scopedStorage from '../../../../../utils/scopedStorage';

const RIBBON_TAB_KEY = 'appStudioRibbonTab';

function renderRibbon() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <AppEditorProvider app={{ definition: KITCHEN_SINK, version: 1 }}>
                <DndContext>
                    <ComponentRibbon onCommit={vi.fn()} />
                </DndContext>
            </AppEditorProvider>
        </QueryClientProvider>,
    );
}

describe('ComponentRibbon — translated group names', () => {
    beforeEach(() => {
        localStorage.clear();
        scopedStorage.setCurrentUser('palette-i18n');
    });

    it('translates the tab labels', () => {
        renderRibbon();
        expect(screen.getByRole('tab', { name: 'Begin hier', selected: true })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Alles' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Gegevens' })).toBeInTheDocument();
        // Untranslated categories keep their English fallback rather than
        // rendering a raw key.
        expect(screen.getByRole('tab', { name: 'Layout' })).toBeInTheDocument();
    });

    it('keeps the ENGLISH id behind a translated tab, so the strip still fills', () => {
        renderRibbon();
        act(() => { fireEvent.click(screen.getByRole('tab', { name: 'Gegevens' })); });

        // Data's components are on screen — the click selected the category
        // 'Data', not the string 'Gegevens'.
        expect(screen.getByTitle(/^Chart — click to add/)).toBeInTheDocument();
        // …and it is the id that is persisted, so a tab stored in one language
        // still resolves in another.
        expect(scopedStorage.getItem(RIBBON_TAB_KEY)).toBe('Data');
    });

    it('translates the cluster caption under the cards too', () => {
        renderRibbon();
        act(() => { fireEvent.click(screen.getByRole('tab', { name: 'Gegevens' })); });
        // Twice: the tab and the caption beneath its cluster.
        expect(screen.getAllByText('Gegevens')).toHaveLength(2);
    });
});

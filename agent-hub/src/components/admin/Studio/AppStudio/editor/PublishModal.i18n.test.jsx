import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../studioAppsApi', () => {
    const studioAppsApi = { publish: vi.fn(), checkApp: vi.fn() };
    return { default: studioAppsApi, studioAppsApi };
});
vi.mock('../rbac/useAppRoles', () => ({ default: vi.fn(), useOrgDirectory: vi.fn() }));
vi.mock('../../../../shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});

/**
 * A translated publish dialog.
 *
 * PublishModal.test.jsx renders the ENGLISH fallbacks — which is what a missing
 * translation still shows, so it cannot see the thing this file exists for. The
 * headings above the issue list used to be built as
 *
 *     `${errors.length} things ${isCheck ? 'are broken' : 'to fix before publishing'}`
 *
 * — a count with an English predicate glued on. That renders identically in
 * English whether or not it is one translatable unit, and the i18n guard cannot
 * see it either: it checks that used keys EXIST, not that a sentence was left
 * whole. Only rendering the dialog in another language tells the two apart, so
 * the four headings are pinned here, one per shape (check/publish × one/many).
 *
 * The stub answers the keys below and hands every other call site its own
 * fallback, so the rest of the dialog reads exactly as it does elsewhere.
 */
// vi.mock's factory is hoisted above every import, so the stub is built inside
// it — a module-scope table would not exist yet when the hook is first imported.
vi.mock('../../../../../hooks/useTranslation', () => {
    const NL = {
        'app_studio.publish.title': 'App publiceren',
        'app_studio.publish.apply': 'Toepassen',
        'app_studio.publish.currently': 'Nu:',
        'app_studio.publish.audience_org': 'Iedereen in je organisatie',
        'app_studio.publish.check': 'Controleer deze app',
        'app_studio.publish.check_all_good': 'Alles is geladen en elke stap klopt.',
        'app_studio.publish.errors_title': '{n} ding om te repareren voor je publiceert',
        'app_studio.publish.errors_title_plural': '{n} dingen om te repareren voor je publiceert',
        'app_studio.publish.check_errors_title': '{n} ding is stuk',
        'app_studio.publish.check_errors_title_plural': '{n} dingen zijn stuk',
        'app_studio.publish.warnings_title': '{n} ding om naar te kijken',
        'app_studio.publish.warnings_title_plural': '{n} dingen om naar te kijken',
        'app_studio.publish.on_screen': 'op “{screen}”',
        'app_studio.header.show_me': 'Laat zien',
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

import PublishModal from './PublishModal';
import useAppRoles, { useOrgDirectory } from '../rbac/useAppRoles';
import { studioAppsApi } from '../studioAppsApi';

const DIRECTORY = { groups: [{ id: 'g1', name: 'Sales' }], users: [], isLoading: false, available: true };
const TABLES = [{ id: 'tbl_1', key: 'absences', name: 'Absences', fields: [], access: { default: 'app', roles: {}, rowFilters: {} } }];
const ACCESS = {
    model: { modelVersion: 1, roles: [], roleMapping: { default: 'app', byGroup: {} }, tables: TABLES, connectors: [] },
    tables: TABLES, roles: [], roleMapping: { default: 'app', byGroup: {} },
    members: [], isLoading: false, isError: false, hasModel: true,
};

const orgApp = { id: 'app-1', name: 'Tracker', isPublished: true, sharedGroups: [], publishedAt: '2026-07-01T10:00:00Z' };
const DEFINITION = {
    screens: [{
        id: 'scr_home',
        name: 'Overview',
        sections: [{ id: 'sec_a', children: [{ id: 'cmp_grid' }] }],
    }],
};

function issue(n) {
    return {
        code: `e${n}`, severity: 'error', path: 'screens',
        message: `Something is wrong (${n}).`, hint: null,
    };
}

/** The 422 the server throws for a draft it refuses, with `n` blockers. */
function rejection(errors, warnings = []) {
    const err = new Error('refused');
    err.status = 422;
    err.body = { error: err.message, errors, warnings };
    return err;
}

const refuse = (errors, warnings) => studioAppsApi.publish.mockRejectedValue(rejection(errors, warnings));
const openAndApply = (extra = {}) => {
    render(<PublishModal open app={orgApp} definition={DEFINITION} onClose={vi.fn()} onPublished={vi.fn()} {...extra} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toepassen' }));
};

beforeEach(() => {
    vi.clearAllMocks();
    useOrgDirectory.mockReturnValue(DIRECTORY);
    useAppRoles.mockReturnValue(ACCESS);
    studioAppsApi.publish.mockResolvedValue({ success: true, isPublished: true, sharedGroups: [] });
    studioAppsApi.checkApp.mockResolvedValue({
        ok: true, static: { errors: [], warnings: [] },
        bindings: [], roleFindings: [], actions: [], emptyTables: [],
    });
});

describe('PublishModal — translated', () => {
    it('translates the dialog chrome and the status line', () => {
        render(<PublishModal open app={orgApp} definition={DEFINITION} onClose={vi.fn()} onPublished={vi.fn()} />);
        expect(screen.getByText('App publiceren')).toBeInTheDocument();
        expect(screen.getByText('Nu:')).toBeInTheDocument();
        expect(screen.getByText('Iedereen in je organisatie')).toBeInTheDocument();
        // Untranslated copy keeps its English fallback rather than a raw key.
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
        expect(screen.queryByText(/app_studio\./)).toBeNull();
    });

    it('translates the pre-flight check, all-clear included', async () => {
        render(<PublishModal open app={orgApp} definition={DEFINITION} onClose={vi.fn()} onPublished={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Controleer deze app' }));
        expect(await screen.findByText('Alles is geladen en elke stap klopt.')).toBeInTheDocument();
    });

    /**
     * The four headings, whole. Each is one key with the count inside it, so a
     * language that puts the number last (or inflects the noun) can — which a
     * "{count} things " + predicate concatenation made impossible.
     */
    it('picks the singular KEY for one blocker, not a singular fragment', async () => {
        refuse([issue(1)]);
        openAndApply();
        expect(await screen.findByText('1 ding om te repareren voor je publiceert')).toBeInTheDocument();
    });

    it('picks the plural KEY for several blockers, count and all', async () => {
        refuse([issue(1), issue(2), issue(3)]);
        openAndApply();
        expect(await screen.findByText('3 dingen om te repareren voor je publiceert')).toBeInTheDocument();
    });

    it('has its own two headings for a check, which is not a refused publish', async () => {
        studioAppsApi.checkApp.mockResolvedValue({
            ok: false,
            static: { errors: [{ code: 'x', message: 'Kapot.', path: 'screens' }], warnings: [] },
            bindings: [], roleFindings: [], actions: [], emptyTables: [],
        });
        render(<PublishModal open app={orgApp} definition={DEFINITION} onClose={vi.fn()} onPublished={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Controleer deze app' }));
        expect(await screen.findByText('1 ding is stuk')).toBeInTheDocument();
        // …and not the publish-context wording, which says something else
        // entirely about what happened to the readers.
        expect(screen.queryByText(/repareren voor je publiceert/)).toBeNull();
    });

    it('translates the warning heading on its own count', async () => {
        refuse([issue(1)], [{ code: 'w', severity: 'warning', message: 'Let op.', path: 'screens' }]);
        openAndApply();
        expect(await screen.findByText('1 ding om naar te kijken')).toBeInTheDocument();
    });

    /**
     * "Show me" is the save-notices button's key, reused rather than copied —
     * one wording, one translation, both places.
     */
    it('reuses the header key for "Show me" and translates the screen it points at', async () => {
        refuse([{
            code: 'x', severity: 'error',
            path: 'screens[0].sections[0].children[0]',
            message: 'Kapot.', hint: null,
        }]);
        // "Show me" only appears when the chrome can actually reveal a node.
        openAndApply({ onRevealNode: vi.fn() });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Laat zien' })).toBeInTheDocument());
        expect(screen.getByText('op “Overview”')).toBeInTheDocument();
    });
});

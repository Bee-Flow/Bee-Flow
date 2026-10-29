import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TranslateFn } from '../../hooks/useTranslation';

/**
 * WebpageDbViewer — the heaviest screen of the retrofit (79 literal strings).
 *
 * t() is a MARKER (`⟦key⟧`), so that a string which falls back to the English fallback becomes visible in the source instead of looking good on screen. The two things that really must be fixed here:
 *   1. the row count chooses a PLURAL KEY, not a stuck-on 's';
 *   2. SQL itself stays SQL — column names, NULL and the type names are machine text and do not belong in the dictionary.
 */

const t: TranslateFn = (key, fallback, params) => {
    const p = typeof fallback === 'string' ? params : fallback;
    const tail = p && typeof p === 'object'
        ? `(${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')})`
        : '';
    return `⟦${key}⟧${tail}`;
};

vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }: { children: ReactNode }) => children,
    ensureI18nDefaults: () => Promise.resolve(),
}));

const authFetch = vi.fn<(url: string, init: { body: string }) => Promise<unknown>>();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args: Parameters<typeof authFetch>) => authFetch(...args),
}));

import WebpageDbViewer from './WebpageDbViewer';

const SCHEMA = {
    tables: [{
        name: 'quotes',
        columns: [
            { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true, defaultValue: null },
            { name: 'status', type: 'TEXT', primaryKey: false, notNull: false, defaultValue: null },
        ],
        sql: 'CREATE TABLE quotes (id INTEGER PRIMARY KEY, status TEXT)',
    }],
};

function ok(body: unknown) { return { ok: true, status: 200, json: async () => body }; }

beforeEach(() => {
    authFetch.mockReset();
    authFetch.mockImplementation(async (url, opts) => {
        const u = String(url);
        if (u.endsWith('/db/schema')) return ok(SCHEMA);
        if (u.endsWith('/db/query')) {
            const sql = JSON.parse(opts.body).sql;
            if (sql.includes('COUNT(*)')) return ok({ rows: [{ n: 1 }], columns: ['n'] });
            return ok({ rows: [{ rowid: 1, id: 1, status: 'open' }], columns: ['rowid', 'id', 'status'] });
        }
        throw new Error(`unexpected fetch: ${u}`);
    });
});

describe('WebpageDbViewer — i18n', () => {
    it('BIJT — de drie tabbladen en de verversknop dragen sleutels', async () => {
        render(<WebpageDbViewer webpageId="wp1" />);

        expect(await screen.findByText('⟦webpages.db.tab_schema⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.tab_browse⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.tab_sql⟧')).toBeInTheDocument();
        // "Refresh" did not yet exist as a key and now stands once at top level — the
        // same key as the button in Apps & data.
        expect(screen.getByText('⟦webpages.refresh⟧')).toBeInTheDocument();
    });

    it('BIJT — de schema-tabel benoemt zijn kolomkoppen via sleutels, en het aantal kolommen met een parameter', async () => {
        render(<WebpageDbViewer webpageId="wp1" />);

        expect(await screen.findByText('⟦webpages.db.col_column⟧')).toBeInTheDocument();
        // These three deliberately point to common.*: their text already existed there,
        // and a second key with the same text is precisely what I18N-CONVENTIES 1.3
        // forbids. What this test guards remains the same — the text goes through a
        // KEY, not as a literal string.
        expect(screen.getByText('⟦common.type⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.col_not_null⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.col_default⟧')).toBeInTheDocument();
        // A PLURAL PAIR, not a bare count key: "1 col" / "2 cols" is already two forms
        // in English, and in Dutch the translator would otherwise get one string for
        // "kolom" AND "kolommen". Once the key stands in the dictionaries, splitting
        // costs a migration per language instead of one line of source.
        expect(screen.getByText('⟦webpages.db.n_col_plural⟧(count=2)')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.tables_count⟧(count=1)')).toBeInTheDocument();
    });

    it('BIJT — één kolom kiest de ENKELVOUDSSLEUTEL', async () => {
        render(<WebpageDbViewer webpageId="wp1" />);
        await screen.findByText('⟦webpages.db.col_column⟧');
        // The fixture has one table with two columns; the singular branch is tested here
        // on the helper itself, so that the choice hangs on the KEY and not on a
        // ternary around the text.
        const { pluralKey } = await import('../../components/admin/Studio/KnowledgeStudio/plural');
        expect(pluralKey('webpages.db.n_col', 1)).toBe('webpages.db.n_col');
        expect(pluralKey('webpages.db.n_col', 2)).toBe('webpages.db.n_col_plural');
    });

    it('BIJT — SQL blijft SQL: kolomnamen en typenamen gaan niet door t() heen', async () => {
        render(<WebpageDbViewer webpageId="wp1" />);
        await screen.findByText('⟦webpages.db.col_column⟧');

        // The name of the table, the column and the type are machine text from the
        // database; a translated column name would produce a broken query.
        expect(screen.getAllByText('quotes').length).toBeGreaterThan(0);
        expect(screen.getByText('status')).toBeInTheDocument();
        expect(screen.getByText('TEXT')).toBeInTheDocument();
    });

    it('BIJT — het rijaantal kiest de meervoudssleutel in plaats van een aangeplakte s', async () => {
        const user = userEvent.setup();
        render(<WebpageDbViewer webpageId="wp1" />);
        await user.click(await screen.findByText('⟦webpages.db.tab_browse⟧'));

        // Precisely one row in the fixture → the SINGULAR KEY, and therefore never
        // "1 rows". With the old `row${n === 1 ? '' : 's'}` this choice existed only
        // in English.
        await waitFor(() => expect(screen.getByText('⟦webpages.db.rows⟧(count=1)')).toBeInTheDocument());
        expect(screen.queryByText(/webpages\.db\.rows_plural/)).not.toBeInTheDocument();
    });

    it('BIJT — de SQL-tab benoemt de leesstand, de knop en de gevarenzone met sleutels', async () => {
        const user = userEvent.setup();
        render(<WebpageDbViewer webpageId="wp1" />);
        await user.click(await screen.findByText('⟦webpages.db.tab_sql⟧'));

        expect(screen.getByText('⟦webpages.db.read_query⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.run⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.danger_zone⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.reset⟧')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('⟦webpages.db.sql_placeholder⟧')).toBeInTheDocument();
    });
});

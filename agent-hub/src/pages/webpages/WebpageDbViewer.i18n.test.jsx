import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WebpageDbViewer — het zwaarste scherm van de retrofit (79 letterlijke strings).
 *
 * t() is een MARKEERDER (`⟦sleutel⟧`), zodat een string die terugvalt op de
 * Engelse fallback in de bron zichtbaar wordt in plaats van er goed uit te zien.
 * De twee dingen die hier echt vast moeten liggen:
 *   1. het rijaantal kiest een MEERVOUDSSLEUTEL, niet een aangeplakte 's';
 *   2. SQL zelf blijft SQL — kolomnamen, NULL en de typenamen zijn machinetekst
 *      en horen niet in het woordenboek.
 */

const t = (key, fallback, params) => {
    const p = typeof fallback === 'string' ? params : fallback;
    const tail = p && typeof p === 'object'
        ? `(${Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',')})`
        : '';
    return `⟦${key}⟧${tail}`;
};

vi.mock('../../hooks/useTranslation', () => ({
    default: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    useTranslation: () => ({ t, locale: 'en', setLocale: () => {}, isLoading: false, strings: {} }),
    TranslationProvider: ({ children }) => children,
    ensureI18nDefaults: () => Promise.resolve(),
}));

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
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

function ok(body) { return { ok: true, status: 200, json: async () => body }; }

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
        // "Refresh" bestond nog niet als sleutel en staat nu één keer op
        // hoofdniveau — dezelfde sleutel als de knop in Apps & data.
        expect(screen.getByText('⟦webpages.refresh⟧')).toBeInTheDocument();
    });

    it('BIJT — de schema-tabel benoemt zijn kolomkoppen via sleutels, en het aantal kolommen met een parameter', async () => {
        render(<WebpageDbViewer webpageId="wp1" />);

        expect(await screen.findByText('⟦webpages.db.col_column⟧')).toBeInTheDocument();
        // Deze drie wijzen bewust naar common.*: hun tekst bestond daar al, en een
        // tweede sleutel met dezelfde tekst is precies wat I18N-CONVENTIES 1.3 verbiedt.
        // Wat deze test bewaakt blijft hetzelfde — de tekst gaat door een SLEUTEL heen,
        // niet als letterlijke string.
        expect(screen.getByText('⟦common.type⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.col_not_null⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.col_default⟧')).toBeInTheDocument();
        // Een MEERVOUDSPAAR, geen kale telsleutel: "1 col" / "2 cols" is in het
        // Engels al twee vormen, en in het Nederlands krijgt de vertaler anders
        // één string voor "kolom" én "kolommen". Zodra de sleutel in de
        // woordenboeken staat kost splitsen een migratie per taal in plaats van
        // een regel bron.
        expect(screen.getByText('⟦webpages.db.n_col_plural⟧(count=2)')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.tables_count⟧(count=1)')).toBeInTheDocument();
    });

    it('BIJT — één kolom kiest de ENKELVOUDSSLEUTEL', async () => {
        render(<WebpageDbViewer webpageId="wp1" />);
        await screen.findByText('⟦webpages.db.col_column⟧');
        // De fixture heeft één tabel met twee kolommen; de enkelvoudige tak
        // wordt hier op de helper zelf getoetst, zodat de keuze aan de SLEUTEL
        // hangt en niet aan een ternary om de tekst.
        const { pluralKey } = await import('../../components/admin/Studio/KnowledgeStudio/plural');
        expect(pluralKey('webpages.db.n_col', 1)).toBe('webpages.db.n_col');
        expect(pluralKey('webpages.db.n_col', 2)).toBe('webpages.db.n_col_plural');
    });

    it('BIJT — SQL blijft SQL: kolomnamen en typenamen gaan niet door t() heen', async () => {
        render(<WebpageDbViewer webpageId="wp1" />);
        await screen.findByText('⟦webpages.db.col_column⟧');

        // De naam van de tabel, de kolom en het type zijn machinetekst uit de
        // database; een vertaalde kolomnaam zou een kapotte query opleveren.
        expect(screen.getAllByText('quotes').length).toBeGreaterThan(0);
        expect(screen.getByText('status')).toBeInTheDocument();
        expect(screen.getByText('TEXT')).toBeInTheDocument();
    });

    it('BIJT — het rijaantal kiest de meervoudssleutel in plaats van een aangeplakte s', async () => {
        render(<WebpageDbViewer webpageId="wp1" />);
        fireEvent.click(await screen.findByText('⟦webpages.db.tab_browse⟧'));

        // Precies één rij in de fixture → de ENKELVOUDSSLEUTEL, en dus nooit
        // "1 rows". Met de oude `row${n === 1 ? '' : 's'}` bestond deze keuze
        // alleen in het Engels.
        await waitFor(() => expect(screen.getByText('⟦webpages.db.rows⟧(count=1)')).toBeInTheDocument());
        expect(screen.queryByText(/webpages\.db\.rows_plural/)).not.toBeInTheDocument();
    });

    it('BIJT — de SQL-tab benoemt de leesstand, de knop en de gevarenzone met sleutels', async () => {
        render(<WebpageDbViewer webpageId="wp1" />);
        fireEvent.click(await screen.findByText('⟦webpages.db.tab_sql⟧'));

        expect(screen.getByText('⟦webpages.db.read_query⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.run⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.danger_zone⟧')).toBeInTheDocument();
        expect(screen.getByText('⟦webpages.db.reset⟧')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('⟦webpages.db.sql_placeholder⟧')).toBeInTheDocument();
    });
});

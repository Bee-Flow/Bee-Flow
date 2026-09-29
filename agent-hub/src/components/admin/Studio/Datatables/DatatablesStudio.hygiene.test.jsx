import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MANAGED_COLUMNS } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import DatatablesStudio from './DatatablesStudio';

/**
 * The hygiene half of the section: the things that were WRONG rather than
 * missing, and that no feature test would have caught.
 *
 *  - it painted itself in three CSS variables agent-hub does not define, so
 *    every fallback hex shipped and this was the one Studio section that stayed
 *    sky-blue whatever accent an organisation picked;
 *  - a deep link that merely FAILED told a legitimate owner the table was not
 *    available to them, with the real error contradicting it underneath;
 *  - both dialogs were hand-rolled `fixed inset-0` divs, so focus stayed on the
 *    page behind them and ESC did nothing;
 *  - the Used-by tab linked a colleague's routine with a raw <a href> that
 *    full-reloads the SPA and lands on nothing;
 *  - a GripVertical handle promised a reorder that did not exist;
 *  - and three separate components each fetched the same usage list.
 */

vi.mock('../../../../utils/helpers', () => ({
    API_BASE: '',
    authFetch: vi.fn(async (url) => ({
        ok: true,
        status: 200,
        json: async () => (String(url).includes('/auth/groups')
            ? [{ id: 'g1', name: 'Sales' }]
            : [{ id: 'u1', name: 'Ada', email: 'ada@example.com' }]),
    })),
}));

vi.mock('./datatablesApi', () => {
    const datatablesApi = {
        list: vi.fn(), create: vi.fn(), createManaged: vi.fn(), get: vi.fn(), remove: vi.fn(),
        getSchema: vi.fn(), putSchema: vi.fn(),
        listRows: vi.fn(), addRow: vi.fn(), deleteRow: vi.fn(),
        setSharing: vi.fn(), listGrants: vi.fn(), addGrant: vi.fn(), removeGrant: vi.fn(),
        listUsage: vi.fn(),
    };
    return { datatablesApi, default: datatablesApi };
});

const TABLE = {
    id: 'tbl_1', name: 'Customers', key: 'customers',
    description: 'People we already e-mailed.', rowCount: 3,
    isPublished: false, sharedGroups: [], writeMode: 'grants',
    scopeKind: 'org', managedKind: null, grade: 'owner',
};
const ORG_SCOPE = { kind: 'org', id: 'org-a', label: 'your organisation' };

function renderStudio(props = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={qc}>
            <DatatablesStudio {...props} />
        </QueryClientProvider>,
    );
}

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    datatablesApi.list.mockResolvedValue({ datatables: [TABLE], scope: ORG_SCOPE });
    datatablesApi.getSchema.mockResolvedValue({
        fields: [
            { id: 'fld_a', key: 'email', name: 'Email', type: 'text' },
            { id: 'fld_b', key: 'stage', name: 'Stage', type: 'text' },
        ],
        modelVersion: 4,
    });
    datatablesApi.listRows.mockResolvedValue({ rows: [], hasMore: false, count: 0 });
    datatablesApi.listGrants.mockResolvedValue({ grants: [] });
    datatablesApi.listUsage.mockResolvedValue({ usage: [] });
});

// ── Theme tokens ────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.resolve(HERE, '../../../../index.css'), 'utf8');

function sectionSources() {
    return fs.readdirSync(HERE)
        .filter(f => /\.(jsx?|tsx?)$/.test(f) && !/\.test\./.test(f))
        .map(f => ({ f, src: fs.readFileSync(path.join(HERE, f), 'utf8') }));
}

describe('the section paints itself in tokens the app actually defines', () => {
    it('names no --color-* variable — every one of them was undefined', () => {
        // `var(--color-primary, #0284c7)` is not a themed colour, it is a hex
        // literal with extra steps: agent-hub defines --accent-primary, --error
        // and --warning and has never defined a --color-anything. The fallback
        // is why this section stayed sky-blue under every org accent, and why
        // its buttons paired white text with a blue index.css documents as
        // failing WCAG at 2.54:1.
        const offenders = [];
        for (const { f, src } of sectionSources()) {
            for (const m of src.matchAll(/--color-[a-z-]+/g)) offenders.push(`${f}: ${m[0]}`);
        }
        expect(offenders).toEqual([]);
    });

    it('every CSS variable it reads is defined in index.css', () => {
        // The general form of the rule above, so the next invented token is
        // caught the day it is written rather than the day someone notices the
        // colour is wrong in one theme.
        const defined = new Set([...CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]));
        const missing = new Set();
        for (const { src } of sectionSources()) {
            for (const m of src.matchAll(/var\((--[a-z0-9-]+)/g)) {
                if (!defined.has(m[1])) missing.add(m[1]);
            }
        }
        expect([...missing]).toEqual([]);
    });

    it('pairs text-white only with a danger background, never with the accent', () => {
        // --accent-primary is a light grey in three of the five themes, so
        // white-on-accent is unreadable. The accent's own foreground token
        // exists precisely for this; rose/--error keeps text-white, matching
        // shared/ConfirmDialog's destructive button.
        for (const { f, src } of sectionSources()) {
            for (const m of src.matchAll(/text-white/g)) {
                const around = src.slice(Math.max(0, m.index - 400), m.index + 400);
                expect(around, `${f} uses text-white outside a danger control`)
                    .toMatch(/var\(--error\)|bg-rose/);
            }
        }
    });
});

// ── The small lies ──────────────────────────────────────────────────────────

describe('a deep link that FAILED is not reported as a permission answer', () => {
    it('shows the error, and not "not available to you"', async () => {
        // Both produce the same missing table on screen, and they mean opposite
        // things: one is "someone else's or deleted", the other is "the request
        // did not happen". Rendering both put two contradictory sentences one
        // above the other.
        datatablesApi.list.mockRejectedValue(new Error('Service unavailable'));
        renderStudio({ initialDatatableId: 'tbl_1' });
        expect(await screen.findByText(/Service unavailable/)).toBeInTheDocument();
        expect(screen.queryByText(/not available to you/i)).toBeNull();
    });

    it('still says it plainly when the list came back fine and the table is simply not in it', async () => {
        renderStudio({ initialDatatableId: 'tbl_missing' });
        expect(await screen.findByText(/not available to you/i)).toBeInTheDocument();
    });
});

describe('the Used-by tab', () => {
    const openUsage = async (usage, props = {}) => {
        datatablesApi.listUsage.mockResolvedValue({ usage });
        renderStudio({ initialDatatableId: 'tbl_1', ...props });
        fireEvent.click(await screen.findByRole('radio', { name: /Used by/ }));
    };

    it('navigates in-app for a routine this account owns', async () => {
        const onNavigate = vi.fn();
        await openUsage(
            [{ automationId: 'a1', automationTitle: 'Nightly sync', automationOwner: 'u1', mode: 'read', columns: [] }],
            { user: { id: 'u1' }, onNavigate },
        );
        fireEvent.click(await screen.findByRole('button', { name: 'Nightly sync' }));
        expect(onNavigate).toHaveBeenCalledWith('studio/routines/a1');
    });

    it("renders a colleague's routine as plain text — usage is org-wide, routines are not", async () => {
        // The old <a href="/app/routines/..."> full-reloads the SPA and then
        // lands on nothing, because a routine you do not own has no page here.
        const onNavigate = vi.fn();
        await openUsage(
            [{ automationId: 'a1', automationTitle: 'Nightly sync', automationOwner: 'u9', mode: 'read', columns: [] }],
            { user: { id: 'u1' }, onNavigate },
        );
        expect(await screen.findByText('Nightly sync')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Nightly sync' })).toBeNull();
        expect(screen.queryByRole('link', { name: /Nightly sync/ })).toBeNull();
        expect(screen.getByText(/someone else/i)).toBeInTheDocument();
    });

    it('is fetched ONCE for the whole detail, not once per panel', async () => {
        // The designer, this tab and the delete confirmation all read it. Three
        // fetches is three chances to disagree about what depends on the table
        // while somebody decides whether to drop a column.
        await openUsage([]);
        // Asserted on the SHAPE, not on a sentence: the empty copy is one of
        // the strings the routine→automation vocabulary sweep rewrites, and a
        // test that pins the wording of a translated value fails on the day
        // somebody improves it rather than on the day the behaviour breaks.
        await screen.findByTestId('used-by');
        fireEvent.click(screen.getByRole('radio', { name: /Columns/ }));
        await screen.findByDisplayValue('Email');
        expect(datatablesApi.listUsage).toHaveBeenCalledTimes(1);
    });

    it('offers the way to connect another one whether or not there is a first', async () => {
        // A permanent hint, not an empty state: "how do I connect another"
        // does not stop being a useful answer once one exists.
        await openUsage([{ automationId: 'a1', automationTitle: 'Nightly sync', automationOwner: 'u9', mode: 'read', columns: [] }]);
        expect(await screen.findByText(/add a Datatable step there and pick this table/i)).toBeInTheDocument();
    });
});

// ── Keyboard and focus ──────────────────────────────────────────────────────

describe('the dialogs are real dialogs', () => {
    it('the create dialog traps focus and closes on ESC', async () => {
        renderStudio({ hasPermission: () => true });
        fireEvent.click((await screen.findAllByRole('button', { name: /new table/i }))[0]);

        const dialog = await screen.findByRole('dialog');
        expect(dialog.contains(document.activeElement)).toBe(true);

        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('the destructive column dialog traps focus and closes on ESC', async () => {
        renderStudio({ initialDatatableId: 'tbl_1', hasPermission: () => true });
        await screen.findByDisplayValue('Email');
        fireEvent.click(screen.getByRole('button', { name: /Remove Email/ }));
        fireEvent.click(screen.getByRole('button', { name: /Save columns/ }));

        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toMatch(/throws away data/i);
        expect(dialog.contains(document.activeElement)).toBe(true);
        // Nothing was saved by opening the question.
        expect(datatablesApi.putSchema).not.toHaveBeenCalled();

        fireEvent.keyDown(document, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(datatablesApi.putSchema).not.toHaveBeenCalled();
    });
});

// ── Reordering, which the grip handle only pretended to offer ────────────────

describe('columns can be reordered', () => {
    it('moving one down — ↓ on its grip, or a drop onto the next row — changes the order that is SAVED', async () => {
        datatablesApi.putSchema.mockResolvedValue({ fields: [], modelVersion: 5 });
        renderStudio({ initialDatatableId: 'tbl_1', hasPermission: () => true });
        await screen.findByDisplayValue('Email');

        // the grip is a button: the keyboard reorder the arrows used to be
        fireEvent.keyDown(screen.getByRole('button', { name: /Reorder Email/ }), { key: 'ArrowDown' });
        // and the same move by mouse, back and forth, leaves the order as the keyboard set it
        const grips = screen.getAllByTestId('column-grip');
        const rows = grips.map(g => g.closest('li'));
        fireEvent.dragStart(grips[0], { dataTransfer: { setData: () => {}, effectAllowed: '' } });
        fireEvent.dragOver(rows[1]);
        fireEvent.drop(rows[1]);
        fireEvent.dragStart(screen.getAllByTestId('column-grip')[0], { dataTransfer: { setData: () => {}, effectAllowed: '' } });
        fireEvent.dragOver(rows[1]);
        fireEvent.drop(rows[1]);
        fireEvent.click(screen.getByRole('button', { name: /Save columns/ }));

        await waitFor(() => expect(datatablesApi.putSchema).toHaveBeenCalled());
        const [, fields] = datatablesApi.putSchema.mock.calls[0];
        expect(fields.map(f => f.key)).toEqual(['stage', 'email']);
        // A reorder throws nothing away, so it must not raise the dialog that
        // asks whether you meant to.
        expect(screen.queryByText(/throws away data/i)).toBeNull();
    });
});

// ── Search ──────────────────────────────────────────────────────────────────

describe('the list can be searched, at every length', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
        ...TABLE, id: `tbl_${i}`, name: `Table ${i}`, key: `t${i}`, description: `holds thing ${i}`,
    }));

    it('the box is there with a single table, not only past four', async () => {
        // It used to appear only above four tables. That is a control that
        // MOVES: the person who learns where it is at six cannot find it at
        // three, and the box costs one row beside the heading (artboard 1b
        // draws it at every length).
        datatablesApi.list.mockResolvedValue({ datatables: [TABLE], scope: ORG_SCOPE });
        renderStudio();
        expect(await screen.findByLabelText(/Search tables/i)).toBeInTheDocument();
    });

    it('filters on name, key and purpose', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: many, scope: ORG_SCOPE });
        renderStudio();
        const box = await screen.findByLabelText(/Search tables/i);
        fireEvent.change(box, { target: { value: 'thing 3' } });
        expect(screen.getByText('Table 3')).toBeInTheDocument();
        expect(screen.queryByText('Table 4')).toBeNull();
    });

    it('says so rather than showing an empty list when nothing matches', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: many, scope: ORG_SCOPE });
        renderStudio();
        fireEvent.change(await screen.findByLabelText(/Search tables/i), { target: { value: 'zzz' } });
        expect(screen.getByText(/No table matches that/i)).toBeInTheDocument();
        // NOT the "no datatables yet" empty state — the person has six.
        expect(screen.queryByText(/No datatables yet/i)).toBeNull();
    });
});

// ── Managed tables ──────────────────────────────────────────────────────────

/**
 * A table whose columns the platform owns. The server refuses a drop or a
 * retype with 409 `managed_column`, and a control you can only discover is
 * forbidden by pressing it is not a control — so the designer refuses first.
 */
// Built from the contract itself, not typed out: a hand-written subset is not
// a managed table, it is a BROKEN one, and the designer rightly refuses to save
// it — which is a confusing way for a fixture to fail.
const MANAGED_FIELDS = [
    ...MANAGED_COLUMNS.http_cache.map((f, i) => ({ ...f, id: `fld_m${i}`, name: f.key })),
    { id: 'fld_mine', key: 'my_note', name: 'My note', type: 'text' },
];

describe('a managed table locks the columns the platform fills in', () => {
    beforeEach(() => {
        datatablesApi.list.mockResolvedValue({
            datatables: [{ ...TABLE, managedKind: 'http_cache', retentionDays: 30, retentionField: 'fetched_at' }],
            scope: ORG_SCOPE,
        });
        datatablesApi.getSchema.mockResolvedValue({ fields: MANAGED_FIELDS, modelVersion: 2 });
    });

    it('offers no way to remove, rename or retype one', async () => {
        renderStudio({ initialDatatableId: 'tbl_1', hasPermission: () => true });
        const locked = await screen.findByDisplayValue('cache_key');
        expect(locked.disabled).toBe(true);
        expect(screen.queryByRole('button', { name: /Remove cache_key/ })).toBeNull();
        // Adding your own stays allowed, and yours stays removable.
        expect(screen.getByDisplayValue('My note').disabled).toBe(false);
        expect(screen.getByRole('button', { name: /Remove My note/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Add a column/ })).toBeInTheDocument();
    });

    it('says what its rows hold, and that the retention window is what expires them', async () => {
        renderStudio({ initialDatatableId: 'tbl_1', hasPermission: () => true });
        // The tab is "Retention" now (artboard 1f). Matched case-insensitively
        // so the assertion survives both the old "Data & retention" value and
        // the swept one landing in the dictionary.
        fireEvent.click(await screen.findByRole('radio', { name: /retention/i }));
        expect(await screen.findByText(/plain text/i)).toBeInTheDocument();
        expect(screen.getByText(/30 days after their fetched_at/)).toBeInTheDocument();
        expect(screen.getByText(/no second, hidden clock/i)).toBeInTheDocument();
    });

    it('the retention column is the one the SWEEP counts from, and is not the author’s to pick here', async () => {
        // http_cache stamps `fetched_at`; a window counted from any other
        // column would be a countdown the sweep never reads.
        renderStudio({ initialDatatableId: 'tbl_1', hasPermission: () => true });
        fireEvent.click(await screen.findByRole('radio', { name: /retention/i }));
        const picker = await screen.findByLabelText(/Date column the age is measured from/i);
        expect(picker.disabled).toBe(true);
        expect(picker.value).toBe('fetched_at');
    });

    it('repeats what it holds before it is deleted', async () => {
        renderStudio({ initialDatatableId: 'tbl_1', hasPermission: () => true });
        fireEvent.click(await screen.findByRole('button', { name: /More about this table/ }));
        fireEvent.click(await screen.findByRole('menuitem', { name: /Delete this table/ }));
        expect(await screen.findByText(/what a third-party service answered/i)).toBeInTheDocument();
    });

    it('surfaces the server sentence if an older tab gets past the guard', async () => {
        // The contract lives on the server; this client may be a stale tab.
        const err = new Error('"cache_key" is part of how this table is filled in automatically');
        err.status = 409;
        err.code = 'managed_column';
        datatablesApi.putSchema.mockRejectedValue(err);
        renderStudio({ initialDatatableId: 'tbl_1', hasPermission: () => true });
        await screen.findByDisplayValue('My note');
        fireEvent.click(screen.getByRole('button', { name: /Remove My note/ }));
        fireEvent.click(screen.getByRole('button', { name: /Save columns/ }));
        // Removing an AUTHOR column asks the destructive question first.
        fireEvent.click(await screen.findByRole('button', { name: /Save anyway/ }));
        expect(await screen.findByText(/filled in automatically/)).toBeInTheDocument();
    });
});

describe('the create dialog can provision one', () => {
    it('sends the kind, omits the description so the server supplies its own, and shows the warning VERBATIM', async () => {
        const warning = 'Rows here hold what a third-party service answered, in plain text.';
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: ORG_SCOPE });
        datatablesApi.createManaged.mockResolvedValue({
            datatable: { ...TABLE, id: 'tbl_new', managedKind: 'http_cache' },
            warning,
        });
        const onNavigate = vi.fn();
        renderStudio({ hasPermission: () => true, onNavigate });

        fireEvent.click((await screen.findAllByRole('button', { name: /new table/i }))[0]);
        fireEvent.click(screen.getByRole('radio', { name: /Web service answers/ }));
        fireEvent.change(screen.getByPlaceholderText('Customers'), { target: { value: 'Answers' } });
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

        await waitFor(() => expect(datatablesApi.createManaged).toHaveBeenCalled());
        expect(datatablesApi.createManaged).toHaveBeenCalledWith({
            kind: 'http_cache', scope: 'organisation', name: 'Answers', key: 'answers',
        });
        // Verbatim: the server owns this sentence so it stays true when the
        // storage does. Paraphrasing is how a warning survives the change that
        // made it wrong.
        expect(await screen.findByText(warning)).toBeInTheDocument();
        // And the dialog stays up until it has been read.
        expect(datatablesApi.create).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /Open the table/ }));
        await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('studio/datatables/tbl_new'));
    });

    it('an ordinary table can be given its first columns in the same dialog', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: ORG_SCOPE });
        datatablesApi.create.mockResolvedValue({ datatable: { ...TABLE, id: 'tbl_new' } });
        renderStudio({ hasPermission: () => true });

        fireEvent.click((await screen.findAllByRole('button', { name: /new table/i }))[0]);
        fireEvent.change(screen.getByPlaceholderText('Customers'), { target: { value: 'Leads' } });
        fireEvent.change(screen.getByPlaceholderText(/onboarding e-mail/i), { target: { value: 'inbound leads' } });
        fireEvent.click(screen.getByRole('button', { name: /Add a column/ }));
        fireEvent.change(screen.getAllByLabelText('Column name')[0], { target: { value: 'Company name' } });
        fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

        await waitFor(() => expect(datatablesApi.create).toHaveBeenCalled());
        expect(datatablesApi.create.mock.calls[0][0].fields)
            .toEqual([{ key: 'company_name', name: 'Company name', type: 'text' }]);
    });

    it('refuses to submit a first column the server would reject', async () => {
        datatablesApi.list.mockResolvedValue({ datatables: [], scope: ORG_SCOPE });
        renderStudio({ hasPermission: () => true });
        fireEvent.click((await screen.findAllByRole('button', { name: /new table/i }))[0]);
        fireEvent.change(screen.getByPlaceholderText('Customers'), { target: { value: 'Leads' } });
        fireEvent.change(screen.getByPlaceholderText(/onboarding e-mail/i), { target: { value: 'inbound leads' } });
        fireEvent.click(screen.getByRole('button', { name: /Add a column/ }));
        // `created_at` is a column every table already has.
        fireEvent.change(screen.getAllByLabelText('Column name')[0], { target: { value: 'created at' } });

        expect(screen.getByText(/every table already has/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^Create$/ }).disabled).toBe(true);
    });
});

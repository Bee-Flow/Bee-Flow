import { describe, it, expect } from 'vitest';
import {
    acceptsAdHocRows, audienceOf, cellText, describeAccess, destructiveChanges, gradeAtLeast,
    GROUPS, isNcMirror, isSourceMirror, isSpreadsheetMirror, joinNames, keyFromName, ncErrorMessage, ORG, PRIVATE,
    providerLogoId, providerName, SOURCE_KINDS, sourceErrorMessage, sourceKindSpec, sourceNameOf, sourceUrlOf,
    sourceWritable, ssErrorMessage, tableIconOf, validateColumns, writeCaveatText,
    columnLabel, columnKeyTitle,
} from './datatableDisplay';

/**
 * The rules a person is judged by, tested without mounting anything.
 *
 * The first block is the one that matters most: on the server an empty
 * `shared_groups` on a PUBLISHED table means the ENTIRE ORGANISATION
 * (auth/audience.js), not "nobody yet". A picker that read it the other way
 * would show "nobody can see this" over a table the whole company can read —
 * a false reassurance about someone else's data, which is worse than showing
 * nothing at all.
 */

describe('an empty group list on a published table means the whole organisation', () => {
    it('reads [] as ORG, never as PRIVATE', () => {
        expect(audienceOf({ isPublished: true, sharedGroups: [] })).toBe(ORG);
    });

    it('reads a non-empty list as GROUPS', () => {
        expect(audienceOf({ isPublished: true, sharedGroups: ['g1'] })).toBe(GROUPS);
    });

    it('an unpublished table is private however its group list looks', () => {
        expect(audienceOf({ isPublished: false, sharedGroups: ['g1'] })).toBe(PRIVATE);
        expect(audienceOf({ isPublished: false, sharedGroups: [] })).toBe(PRIVATE);
        expect(audienceOf(null)).toBe(PRIVATE);
    });
});

describe('reading and writing are described separately', () => {
    it('publishing to the org does NOT by itself make it org-writable', () => {
        const a = describeAccess({ isPublished: true, sharedGroups: [], writeMode: 'grants' });
        expect(a.readers).toMatch(/Everyone in your organisation/);
        expect(a.writers).toMatch(/only the people you invite/);
        expect(a.broad).toBe(false);
    });

    it('the loud combination is flagged as loud', () => {
        const a = describeAccess({ isPublished: true, sharedGroups: [], writeMode: 'audience' });
        expect(a.broad).toBe(true);
    });

    it('groups are named, not shown as ids', () => {
        const a = describeAccess(
            { isPublished: true, sharedGroups: ['g1', 'g2'], writeMode: 'grants' },
            new Map([['g1', 'Sales'], ['g2', 'Support']]),
        );
        expect(a.readers).toBe('Members of Sales and Support');
    });

    it('falls back to the id rather than rendering "undefined"', () => {
        const a = describeAccess({ isPublished: true, sharedGroups: ['g9'], writeMode: 'grants' });
        expect(a.readers).toContain('g9');
    });
});

describe('joinNames', () => {
    it('reads as a sentence', () => {
        expect(joinNames(['a'])).toBe('a');
        expect(joinNames(['a', 'b'])).toBe('a and b');
        expect(joinNames(['a', 'b', 'c'])).toBe('a, b and c');
        expect(joinNames([])).toBe('');
    });
});

describe('the grade ladder matches auth/projectAccess ROLE_ORDER', () => {
    it('orders viewer < editor < owner', () => {
        expect(gradeAtLeast('owner', 'editor')).toBe(true);
        expect(gradeAtLeast('editor', 'editor')).toBe(true);
        expect(gradeAtLeast('viewer', 'editor')).toBe(false);
        expect(gradeAtLeast(null, 'viewer')).toBe(false);
        expect(gradeAtLeast(undefined, 'viewer')).toBe(false);
    });
});

describe('keyFromName never produces a key the server would refuse', () => {
    const cases = [
        ['Invoice date', 'invoice_date'],
        ['  E-mail  ', 'e_mail'],
        ['Prijs (€)', 'prijs'],
        ['Genöme', 'genome'],
        ['2024 total', 'c_2024_total'],   // may not start with a digit
        ['___', ''],
        ['', ''],
    ];
    for (const [input, expected] of cases) {
        it(`"${input}" → "${expected}"`, () => {
            expect(keyFromName(input)).toBe(expected);
        });
    }

    it('every non-empty result passes the server grammar', () => {
        const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;
        for (const [input] of cases) {
            const k = keyFromName(input);
            if (k) expect(k, `${input} → ${k}`).toMatch(KEY_RE);
        }
    });

    it('a very long name is truncated to something still valid', () => {
        const k = keyFromName('x'.repeat(200));
        expect(k.length).toBeLessThanOrEqual(63);
        expect(k).toMatch(/^[a-z][a-z0-9_]*$/);
    });
});

describe('validateColumns refuses what the DDL would choke on', () => {
    it('accepts an ordinary list', () => {
        expect(validateColumns([{ key: 'email', name: 'Email', type: 'text' }])).toEqual([]);
    });

    it('refuses a system column name', () => {
        const errs = validateColumns([{ key: 'created_at', name: 'When', type: 'date' }]);
        expect(errs.join(' ')).toMatch(/every table already has/);
    });

    it('refuses a duplicate key', () => {
        const errs = validateColumns([
            { key: 'a', name: 'A', type: 'text' },
            { key: 'a', name: 'A again', type: 'text' },
        ]);
        expect(errs.join(' ')).toMatch(/more than one column/);
    });

    it('refuses a key the server grammar would reject', () => {
        expect(validateColumns([{ key: '2col', name: 'X', type: 'text' }]).length).toBeGreaterThan(0);
        expect(validateColumns([{ key: 'Col', name: 'X', type: 'text' }]).length).toBeGreaterThan(0);
    });

    it('a list column with no options is not a list', () => {
        const errs = validateColumns([{ key: 'stage', name: 'Stage', type: 'select', options: [] }]);
        expect(errs.join(' ')).toMatch(/at least one option/);
    });

    it('refuses an unknown type rather than sending it', () => {
        expect(validateColumns([{ key: 'a', name: 'A', type: 'relation' }]).length).toBeGreaterThan(0);
    });
});

describe('destructiveChanges names what a save would throw away', () => {
    const before = [
        { key: 'email', type: 'text' },
        { key: 'total', type: 'number' },
        { key: 'note', type: 'text' },
    ];

    it('an added column is not destructive', () => {
        const c = destructiveChanges(before, [...before, { key: 'new', type: 'text' }]);
        expect(c.any).toBe(false);
    });

    it('a renamed LABEL is not destructive — only the key matters', () => {
        const c = destructiveChanges(before, before.map(f => ({ ...f, name: 'Renamed' })));
        expect(c.any).toBe(false);
    });

    it('a removed column is', () => {
        const c = destructiveChanges(before, before.filter(f => f.key !== 'note'));
        expect(c.removed).toEqual(['note']);
        expect(c.any).toBe(true);
    });

    it('a retyped column is, and says both types', () => {
        const c = destructiveChanges(before, before.map(f => (f.key === 'total' ? { ...f, type: 'text' } : f)));
        expect(c.retyped).toEqual([{ key: 'total', from: 'number', to: 'text' }]);
        expect(c.any).toBe(true);
    });
});

describe('cellText never dresses an empty value as a real one', () => {
    it('shows a dash for nothing', () => {
        for (const v of [null, undefined, '']) expect(cellText(v, 'text')).toBe('—');
    });

    it('does not turn a real false into a dash', () => {
        expect(cellText(false, 'bool')).toBe('No');
        expect(cellText(true, 'bool')).toBe('Yes');
    });

    it('shows a real zero', () => {
        expect(cellText(0, 'number')).toBe('0');
    });

    it('renders a list readably', () => {
        expect(cellText(['a', 'b'], 'multiselect')).toBe('a, b');
    });
});

// ── Source mirrors: two kinds, one vocabulary ───────────────────────────────

/** The fallback t(): the English with its placeholders filled — what an untranslated screen shows. */
const t = (key, en, params) => Object.entries(params || {}).reduce((out, [k, v]) => out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)), en);

const NC = { managedKind: 'nextcloud_table', source: { kind: 'nextcloud_table', ncTableId: 4, ncViewId: null, ncUrl: 'http://nc/apps/tables/#/table/4' } };
const SS = { managedKind: 'spreadsheet_file', source: { kind: 'spreadsheet_file', provider: 'onedrive', format: 'xlsx', webUrl: 'https://1drv.ms/x/abc', writable: true } };
const SS_RO = { managedKind: 'spreadsheet_file', source: { kind: 'spreadsheet_file', provider: 'nextcloud_files', format: 'xls', webUrl: null, writable: false, writeMode: 'none', writeReason: 'xls' } };
const CACHE = { managedKind: 'http_cache' };
const PLAIN = { managedKind: null };

describe('a mirror is either kind, and the predicates tell them apart', () => {
    it('isSourceMirror covers both kinds and nothing else', () => {
        expect(isSourceMirror(NC)).toBe(true);
        expect(isSourceMirror(SS)).toBe(true);
        expect(isSourceMirror(CACHE)).toBe(false);
        expect(isSourceMirror(PLAIN)).toBe(false);
        expect(isSourceMirror(null)).toBe(false);
    });

    it('the kind-specific predicates do not overlap', () => {
        expect(isNcMirror(NC)).toBe(true);
        expect(isNcMirror(SS)).toBe(false);
        expect(isSpreadsheetMirror(SS)).toBe(true);
        expect(isSpreadsheetMirror(NC)).toBe(false);
    });

    it('tableIconOf names the glyph, and the registry entry agrees with it', () => {
        expect(tableIconOf(NC)).toBe('nextcloud');
        expect(tableIconOf(SS)).toBe('spreadsheet');
        expect(tableIconOf(CACHE)).toBeNull();
        expect(tableIconOf(PLAIN)).toBeNull();
        expect(sourceKindSpec(NC).icon).toBe(tableIconOf(NC));
        expect(sourceKindSpec(SS).icon).toBe(tableIconOf(SS));
        expect(sourceKindSpec(CACHE)).toBeNull();
    });
});

describe('the word that fills {source}', () => {
    it('is "Nextcloud" for a Tables mirror and the storage\'s proper noun for a spreadsheet', () => {
        expect(sourceNameOf(NC)).toBe('Nextcloud');
        expect(sourceNameOf(SS)).toBe('OneDrive');
        expect(sourceNameOf(SS_RO)).toBe('Nextcloud');
        expect(sourceNameOf({ ...SS, source: { provider: 'google_drive' } })).toBe('Google Drive');
        expect(sourceNameOf(PLAIN)).toBe('');
    });

    it('providerName never returns undefined, and providerLogoId puts the Sheets mark on a native sheet', () => {
        expect(providerName('google_drive')).toBe('Google Drive');
        expect(providerName(undefined)).toBe('');
        expect(providerLogoId('google_drive', 'gsheet')).toBe('google_sheets');
        expect(providerLogoId('google_drive', 'xlsx')).toBe('google_drive');
        expect(providerLogoId('nextcloud_files', 'csv')).toBe('nextcloud');
        expect(providerLogoId('onedrive', 'xlsx')).toBe('onedrive');
    });

    it('the shared sentences render byte-identically to the Nextcloud wording they replace', () => {
        // The pinned Nextcloud suite reads these exact strings off the screen;
        // the generic component fills {source} and must land on the same text.
        expect(t('datatables.src_status_live', 'Live · in step with {source}', { source: sourceNameOf(NC) })).toBe('Live · in step with Nextcloud');
        expect(t('datatables.src_columns_locked', 'These columns come from {source} and cannot be added to, removed, renamed or retyped here. Change them in {source} — the next refresh brings them here.', { source: sourceNameOf(NC) }))
            .toBe('These columns come from Nextcloud and cannot be added to, removed, renamed or retyped here. Change them in Nextcloud — the next refresh brings them here.');
        expect(t('datatables.src_open_in', 'Open in {source}', { source: sourceNameOf(NC) })).toBe('Open in Nextcloud');
        expect(t('datatables.src_required', 'required in {source}', { source: sourceNameOf(NC) })).toBe('required in Nextcloud');
    });
});

describe('where "Open in {source}" goes', () => {
    it('is the Tables deep link for a Nextcloud mirror — the server\'s when it sent one', () => {
        expect(sourceUrlOf(NC)).toBe('http://nc/apps/tables/#/table/4');
        expect(sourceUrlOf({ ...NC, source: { ncTableId: 4, ncViewId: 9 } })).toBe('/apps/tables/#/view/9');
        expect(sourceUrlOf({ ...NC, source: { ncTableId: 4, ncViewId: null } })).toBe('/apps/tables/#/table/4');
    });

    it('is the file\'s webUrl for a spreadsheet, and null when the storage has none', () => {
        expect(sourceUrlOf(SS)).toBe('https://1drv.ms/x/abc');
        expect(sourceUrlOf(SS_RO)).toBeNull();
        expect(sourceUrlOf(PLAIN)).toBeNull();
    });
});

describe('what may be written', () => {
    it('a Nextcloud mirror and a writable file take rows; a read-only file, a cache and nothing do not', () => {
        expect(sourceWritable(NC)).toBe(true);
        expect(sourceWritable(SS)).toBe(true);
        expect(sourceWritable(SS_RO)).toBe(false);
        expect(sourceWritable(CACHE)).toBe(false);
    });

    it('acceptsAdHocRows refuses a read-only file — the row would have nowhere to go', () => {
        expect(acceptsAdHocRows(PLAIN)).toBe(true);
        expect(acceptsAdHocRows(NC)).toBe(true);
        expect(acceptsAdHocRows(SS)).toBe(true);
        expect(acceptsAdHocRows(SS_RO)).toBe(false);
        expect(acceptsAdHocRows(CACHE)).toBe(false);
    });

    it('writeCaveatText names the mechanism, and for a file that is not written, the reason', () => {
        expect(writeCaveatText(t, 'exceljs_put')).toMatch(/charts, pivot tables and macros/);
        expect(writeCaveatText(t, 'none', 'xls')).toMatch(/Save it as \.xlsx/);
        expect(writeCaveatText(t, 'none', 'not_owned')).toMatch(/belongs to someone else/);
        expect(writeCaveatText(t, 'none')).toMatch(/cannot be changed from Bee Flow/);
        expect(writeCaveatText(t, 'something_else')).toBeNull();
    });
});

describe('ssErrorMessage — one sentence per server code', () => {
    const err = (code, extra = {}, message = 'detail from the file') => Object.assign(new Error(message), { code, body: { code, ...extra } });

    it('names the storage from the table, else from the error\'s ref, else "the storage"', () => {
        expect(ssErrorMessage(t, err('provider_not_connected'), 'OneDrive')).toMatch(/^OneDrive is not connected/);
        expect(ssErrorMessage(t, err('provider_not_connected', { ref: { provider: 'google_drive' } }))).toMatch(/^Google Drive is not connected/);
        expect(ssErrorMessage(t, err('provider_not_connected'))).toMatch(/^the storage is not connected/);
    });

    it('an expired connection is its own sentence, carried as the detail of provider_not_connected', () => {
        expect(ssErrorMessage(t, err('provider_not_connected', { detail: 'needs_reauth' }), 'OneDrive')).toMatch(/OneDrive connection has expired/);
    });

    it.each([
        ['provider_integration_off', /switched off for this organisation/],
        ['nc_scope_denied', /Nextcloud files yet/],
        ['spreadsheet_forbidden', /may not change the file/],
        ['spreadsheet_not_found', /no longer where it was in OneDrive\. Unlink this table and link the file again/],
        ['sheet_missing', /sheet is no longer in the file\. Unlink this table and link the sheet/],
        ['spreadsheet_conflict', /changed while this row was being written/],
        ['spreadsheet_locked', /locked by someone else/],
        ['already_linked', /already linked here/],
        ['key_duplicate', /already in the sheet: detail from the file/],
        ['spreadsheet_write_unsupported', /cannot be changed from here/],
        ['spreadsheet_too_large', /too large/],
        ['format_unsupported', /cannot be linked/],
        ['header_missing', /does not look like a header row/],
        ['key_missing', /key column is empty/],
        ['spreadsheet_rejected', /did not accept the row: detail from the file/],
        ['spreadsheet_unavailable', /could not be reached/],
        ['linker_unavailable', /could not be reached/],
        ['schema_from_source', /Re-read the columns/],
        ['mirror_no_retention', /not aged out/],
        ['mirror_row_scope', /each person’s own rows/],
        ['derived_column', /filled in from a relation/],
        ['no_shared_root', /shared with me/],
    ])('%s → a sentence', (code, rx) => {
        expect(ssErrorMessage(t, err(code), 'OneDrive')).toMatch(rx);
    });

    it('key_not_unique names the column, and a write refused for a reason says the reason', () => {
        expect(ssErrorMessage(t, err('key_not_unique', { header: 'Leverancier' }))).toMatch(/“Leverancier” is not unique/);
        expect(ssErrorMessage(t, err('spreadsheet_write_unsupported', { reason: 'ods' }))).toMatch(/\.ods/);
    });

    it('answers null for a code it does not know, so the caller keeps its own default', () => {
        expect(ssErrorMessage(t, err('row_conflict'))).toBeNull();
        expect(ssErrorMessage(t, null)).toBeNull();
    });

    it('a Nextcloud scope refusal is about the CALLER\'s folders in the wizard, and about the linker\'s on a linked table', () => {
        // The wizard (browse, describe, link) runs as the person looking: the
        // storage word is "Nextcloud" there too, so the word cannot tell the
        // contexts apart — only the `linked` flag can. Without it, the remedy
        // is their own Settings → Connections → Nextcloud, never "ask an owner".
        expect(ssErrorMessage(t, err('nc_scope_denied'), 'Nextcloud')).toMatch(/Settings → Connections → Nextcloud/);
        expect(ssErrorMessage(t, err('nc_scope_denied'), 'Nextcloud')).not.toMatch(/account that linked this table/);
        expect(ssErrorMessage(t, err('nc_scope_denied'), 'Nextcloud', { linked: true })).toMatch(/no longer shares it with Bee Flow/);
    });

    it('a moved file or a missing sheet says what the surface can do — unlink and link again — never a re-point it has no button for', () => {
        for (const code of ['spreadsheet_not_found', 'sheet_missing']) {
            const msg = ssErrorMessage(t, err(code), 'OneDrive');
            expect(msg).toMatch(/Unlink this table and link the/);
            expect(msg).not.toMatch(/re-link|point it at the file again/);
        }
    });
});

describe('sourceErrorMessage dispatches by kind', () => {
    const err = (code) => Object.assign(new Error('x'), { code, body: { code } });

    it('a Nextcloud mirror gets the Nextcloud sentence, a spreadsheet the file\'s', () => {
        expect(sourceErrorMessage(t, err('already_linked'), NC)).toBe(ncErrorMessage(t, err('already_linked')));
        expect(sourceErrorMessage(t, err('already_linked'), SS)).toBe('That sheet is already linked here.');
        expect(sourceErrorMessage(t, err('spreadsheet_conflict'), SS)).toMatch(/file changed/);
        expect(sourceErrorMessage(t, err('nextcloud_rejected'), NC)).toMatch(/Nextcloud did not accept/);
    });

    it('with a linked spreadsheet table, a Nextcloud scope refusal is the linker\'s to fix — the wizard wording is for no table', () => {
        expect(sourceErrorMessage(t, err('nc_scope_denied'), SS)).toMatch(/no longer shares it with Bee Flow/);
        expect(ssErrorMessage(t, err('nc_scope_denied'))).toMatch(/Settings → Connections → Nextcloud/);
    });

    it('with no table, a code both kinds use reads as Nextcloud (what the dialogs said before), a spreadsheet-only code as the file', () => {
        expect(sourceErrorMessage(t, err('already_linked'))).toBe(ncErrorMessage(t, err('already_linked')));
        expect(sourceErrorMessage(t, err('spreadsheet_locked'))).toMatch(/locked by someone else/);
        expect(sourceErrorMessage(t, err('unknown_code'))).toBeNull();
    });
});

describe('the SOURCE_KINDS registry', () => {
    it('has an entry per source-managed kind, each a function over t so the guard sees the keys', () => {
        for (const kind of ['nextcloud_table', 'spreadsheet_file']) {
            const spec = SOURCE_KINDS[kind];
            expect(spec.kind).toBe(kind);
            expect(typeof spec.tabLabel(t)).toBe('string');
            expect(spec.liveExplain(t)).toMatch(/within seconds/);
            expect(spec.truncated(t, '10,000')).toMatch(/10,000/);
            expect(spec.linkedBody(t, 1)).toMatch(/The table is being filled in/);
            expect(spec.linkedBody(t, 3)).toMatch(/^3 tables/);
        }
        expect(SOURCE_KINDS.nextcloud_table.unlinkNotice(t)).toMatch(/table in Nextcloud/);
        expect(SOURCE_KINDS.spreadsheet_file.unlinkNotice(t, 'OneDrive')).toMatch(/file in OneDrive/);
    });
});

describe('a column is called what a person would call it, not what the database calls it', () => {
    /**
     * `c.name || c.key` is fine for a column somebody typed a name for and
     * wrong for every column that arrived without one — an imported CSV, a
     * Nextcloud or spreadsheet mirror, a form-answers table, a column a
     * routine created. Those carry a key and no name, so the studio showed
     * people `contact_email` and `created_at`: the database's spelling, in
     * the one screen whose job is to make a table readable to someone who
     * does not think in databases.
     */
    it('falls back to the key made readable, never to the raw key', () => {
        expect(columnLabel({ key: 'contact_email' })).toBe('Contact email');
        expect(columnLabel({ key: 'createdAt' })).toBe('Created at');
        expect(columnLabel({ key: 'invoice_pdf_url' })).toBe('Invoice PDF url');
    });

    it('a name the person typed always wins, including one that looks like a key', () => {
        expect(columnLabel({ key: 'contact_email', name: 'Who to mail' })).toBe('Who to mail');
        // The forward trip is keyFromName; a round trip must not rewrite what
        // they wrote, even when it happens to be lower case with underscores.
        expect(columnLabel({ key: 'x', name: 'contact_email' })).toBe('contact_email');
        expect(columnLabel({ key: 'contact_email', name: '   ' })).toBe('Contact email');
    });

    it('is the SAME humaniser the builder uses, not a second one', async () => {
        // A datatable column and a step's output field are the same idea to
        // the person reading them. Two humanisers would eventually call
        // `from_email` different things on two screens — which is exactly the
        // argument ColumnKind.jsx already makes for borrowing FieldKindIcon.
        const { humanizeFieldKey } = await import('../../../automation/Builder/flow/displayHelpers');
        for (const key of ['from_email', 'htmlUrl', 'messageId', 'pdf_url', 'created_at']) {
            expect(columnLabel({ key })).toBe(humanizeFieldKey(key));
        }
    });

    it('keeps the exact key one hover away, and only when it differs', () => {
        // "The card shows the sentence. The tooltip keeps the exact value."
        // Whoever is writing {{steps.x.output.contact_email}} needs the real
        // spelling — and a tooltip that repeats the visible text is noise a
        // screen reader reads twice.
        expect(columnKeyTitle({ key: 'contact_email' })).toBe('contact_email');
        expect(columnKeyTitle({ key: 'contact_email', name: 'Who to mail' })).toBe('contact_email');
        expect(columnKeyTitle({ key: 'status', name: 'status' })).toBeUndefined();
        expect(columnKeyTitle({})).toBeUndefined();
    });

    it('never throws on the shapes a half-loaded table hands it', () => {
        for (const bad of [null, undefined, 'nope', 42, []]) {
            expect(() => columnLabel(bad)).not.toThrow();
            expect(columnLabel(bad)).toBe('');
        }
    });
});

import { describe, expect, it } from 'vitest';
import {
    INFERABLE_TYPES, applyDefaults, baseName, buildLinkBody, dedupeKeys, defaultName, describeKeyOf, fileKeyOf,
    filesSelectedIn, isProviderError, keyColumnEligible, mergeColumns, newSelection, sheetKeyOf, sheetLabelOf, sheetsChosenIn,
    ssReasonText, stepForError,
} from './wizardState';

/**
 * The wizard's rules, judged without a DOM: what a table is called, which
 * technical name it gets when two collide, which column may be the key,
 * what the server is sent — EXACTLY the contract — and where a refusal
 * sends the person back to.
 */

const t = (key, fallback, params) => Object.entries(params || {}).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), fallback);

const FILE = { provider: 'google_drive', id: 'f1', name: 'Facturen 2026.xlsx', format: 'xlsx', path: null };
const NC_FILE = { provider: 'nextcloud_files', id: '4711', name: 'klanten.csv', format: 'csv', path: '/Documents/klanten.csv' };

describe('keys', () => {
    it('name a file by its storage AND its id — two storages can hand out the same id', () => {
        expect(fileKeyOf('google_drive', 'f1')).toBe('google_drive:f1');
        expect(sheetKeyOf('google_drive:f1', 'Facturen')).toBe('google_drive:f1#Facturen');
        expect(describeKeyOf('google_drive:f1', 'Facturen', 2)).toBe('google_drive:f1#Facturen@2');
    });
});

describe('default names', () => {
    it('drops the extension, and keeps a Google Sheet name whole', () => {
        expect(baseName('Facturen 2026.xlsx')).toBe('Facturen 2026');
        expect(baseName('klanten.csv')).toBe('klanten');
        expect(baseName('Planning Q3')).toBe('Planning Q3');
        expect(baseName('v1.2 overzicht.ods')).toBe('v1.2 overzicht');
    });

    it('is the file name for one sheet, "file – sheet" when the file contributes several', () => {
        expect(defaultName(FILE, 'Facturen', 1)).toBe('Facturen 2026');
        expect(defaultName(FILE, 'Facturen', 2)).toBe('Facturen 2026 – Facturen');
    });

    it('follows the "one or several" rule as sheets come and go, unless the person typed a name', () => {
        let sel = new Map();
        const a = newSelection(FILE, 'Facturen');
        sel.set(a.sheetKey, a);
        sel = applyDefaults(sel);
        expect(sel.get(a.sheetKey)).toMatchObject({ name: 'Facturen 2026', key: 'facturen_2026' });

        const b = newSelection(FILE, 'Leveranciers');
        sel.set(b.sheetKey, b);
        sel = applyDefaults(sel);
        expect(sel.get(a.sheetKey)).toMatchObject({ name: 'Facturen 2026 – Facturen', key: 'facturen_2026_facturen' });
        expect(sel.get(b.sheetKey)).toMatchObject({ name: 'Facturen 2026 – Leveranciers', key: 'facturen_2026_leveranciers' });

        // A typed name stays; its key follows the typed name until touched too.
        sel.set(a.sheetKey, { ...sel.get(a.sheetKey), name: 'Bonnen', nameTouched: true });
        sel.delete(b.sheetKey);
        sel = applyDefaults(sel);
        expect(sel.get(a.sheetKey)).toMatchObject({ name: 'Bonnen', key: 'bonnen' });
    });

    it('hands back the SAME map when nothing moved', () => {
        const a = newSelection(FILE, 'Facturen');
        const sel = applyDefaults(new Map([[a.sheetKey, a]]));
        expect(applyDefaults(sel)).toBe(sel);
    });
});

describe('dedupeKeys', () => {
    it('suffixes _2, _3 on untouched keys in selection order and leaves a typed key alone', () => {
        const mk = (sheetKey, name, extra = {}) => ({ sheetKey, name, key: '', keyTouched: false, ...extra });
        const sel = new Map([
            ['a', mk('a', 'Klanten')],
            ['b', mk('b', 'Klanten')],
            ['c', mk('c', 'Klanten')],
            ['d', mk('d', 'Other', { key: 'klanten_2', keyTouched: true })],
        ]);
        const out = dedupeKeys(sel);
        expect([...out.values()].map(s => s.key)).toEqual(['klanten', 'klanten_3', 'klanten_4', 'klanten_2']);
        expect(out.get('d')).toBe(sel.get('d'));
    });
});

describe('counting', () => {
    it('counts sheets per file and files per storage', () => {
        const a = newSelection(FILE, 'A'), b = newSelection(FILE, 'B'), c = newSelection(NC_FILE, 'klanten');
        const sel = new Map([[a.sheetKey, a], [b.sheetKey, b], [c.sheetKey, c]]);
        expect(sheetsChosenIn(sel, a.fileKey)).toBe(2);
        expect(sheetsChosenIn(sel, c.fileKey)).toBe(1);
        const files = new Map([[a.fileKey, { ...FILE }], [c.fileKey, { ...NC_FILE }]]);
        expect(filesSelectedIn(files, 'google_drive')).toBe(1);
        expect(filesSelectedIn(files, 'onedrive')).toBe(0);
    });
});

describe('keyColumnEligible', () => {
    const CANDIDATES = [0, 2];
    it('is only a column the server found unique, still text or number, with a header', () => {
        expect(keyColumnEligible({ col: 2, header: 'Factuurnummer', type: 'text', blankHeader: false }, CANDIDATES)).toEqual({ ok: true, reason: null });
        expect(keyColumnEligible({ col: 0, header: 'Nr', type: 'number', blankHeader: false }, CANDIDATES)).toEqual({ ok: true, reason: null });
        expect(keyColumnEligible({ col: 1, header: 'Leverancier', type: 'text', blankHeader: false }, CANDIDATES)).toEqual({ ok: false, reason: 'repeats' });
        expect(keyColumnEligible({ col: 2, header: '', type: 'text', blankHeader: true }, CANDIDATES)).toEqual({ ok: false, reason: 'no_header' });
        // Retyped to a date after the server said "unique": no longer an identifier.
        expect(keyColumnEligible({ col: 2, header: 'Datum', type: 'date', blankHeader: false }, CANDIDATES)).toEqual({ ok: false, reason: 'type' });
        expect(keyColumnEligible(null, CANDIDATES).ok).toBe(false);
    });
});

describe('mergeColumns', () => {
    it('keeps a type the person chose where col AND header still match, else takes the new inference', () => {
        const prev = [
            { col: 0, header: 'Datum', type: 'text', typeTouched: true },
            { col: 1, header: 'Bedrag', type: 'number' },
            { col: 2, header: 'Oud', type: 'select', typeTouched: true },
        ];
        const next = [
            { col: 0, header: 'Datum', type: 'date' },
            { col: 1, header: 'Bedrag', type: 'text' },
            { col: 2, header: 'Nieuw', type: 'text' },
        ];
        expect(mergeColumns(prev, next)).toEqual([
            { col: 0, header: 'Datum', type: 'text', typeTouched: true },
            { col: 1, header: 'Bedrag', type: 'text' },
            { col: 2, header: 'Nieuw', type: 'text' },
        ]);
    });
});

describe('INFERABLE_TYPES', () => {
    it('is the six a header row can declare, in the designer\'s own order', () => {
        expect(INFERABLE_TYPES.map(x => x.type)).toEqual(['text', 'number', 'bool', 'date', 'datetime', 'select']);
    });
});

describe('buildLinkBody', () => {
    it('is EXACTLY the contract: 0-based col, keyColumn int|null, path only where there is one, optionals only when set', () => {
        const a = { ...newSelection(FILE, 'Facturen'), name: ' Facturen 2026 ', key: 'facturen_2026', keyColumn: 2,
            columns: [
                { col: 0, letter: 'A', header: 'Datum', key: 'datum', type: 'date', samples: ['2026-01-02'] },
                { col: 2, letter: 'C', header: 'Factuurnummer', key: 'factuurnummer', type: 'text', typeTouched: true },
            ] };
        const b = { ...newSelection(NC_FILE, 'klanten'), name: 'klanten', key: 'klanten', description: ' Our customers ', sharedWriteOptIn: true,
            columns: [{ col: 0, header: 'Naam', type: 'text' }] };
        const sel = new Map([[a.sheetKey, a], [b.sheetKey, b]]);
        const relations = [{
            from: { refKey: a.sheetKey, provider: 'google_drive', fileId: 'f1', sheet: 'Facturen' }, localColumn: { id: '2', title: 'Factuurnummer', type: 'text', col: 2 },
            to: { refKey: b.sheetKey, provider: 'nextcloud_files', fileId: '4711', sheet: 'klanten' }, targetColumn: { id: '0', title: 'Naam', type: 'text', col: 0 },
        }];
        expect(buildLinkBody({ scope: 'organisation', selection: sel, relations })).toEqual({
            scope: 'organisation',
            tables: [
                {
                    provider: 'google_drive', fileId: 'f1', sheet: 'Facturen', headerRow: 1, keyColumn: 2,
                    columns: [{ col: 0, header: 'Datum', type: 'date' }, { col: 2, header: 'Factuurnummer', type: 'text' }],
                    name: 'Facturen 2026', key: 'facturen_2026',
                },
                {
                    provider: 'nextcloud_files', fileId: '4711', path: '/Documents/klanten.csv', sheet: 'klanten', headerRow: 1, keyColumn: null,
                    columns: [{ col: 0, header: 'Naam', type: 'text' }],
                    sharedWriteOptIn: true, name: 'klanten', key: 'klanten', description: 'Our customers',
                },
            ],
            relations: [{
                from: { provider: 'google_drive', fileId: 'f1', sheet: 'Facturen', col: 2 },
                to: { provider: 'nextcloud_files', fileId: '4711', sheet: 'klanten', col: 0 },
            }],
        });
    });

    it('never sends a letter as the key column', () => {
        const a = { ...newSelection(FILE, 'Facturen'), name: 'x', key: 'x', keyColumn: 'C' };
        expect(buildLinkBody({ scope: 'personal', selection: new Map([[a.sheetKey, a]]), relations: [] }).tables[0].keyColumn).toBeNull();
    });

    it('a csv\'s only sheet is `null` on the wire, in the table AND in a relation end — never the word "null"', () => {
        // The server lists a csv's sheet as { name: null } and takes null back;
        // it ignores the sheet for a csv, but a "null" STRING would be a sheet
        // it cannot find.
        const csv = { ...newSelection(NC_FILE, null), name: 'klanten', key: 'klanten', columns: [{ col: 0, header: 'Naam', type: 'text' }] };
        const xlsx = { ...newSelection(FILE, 'Facturen'), name: 'f', key: 'f', columns: [{ col: 1, header: 'Leverancier', type: 'text' }] };
        const relations = [{
            from: { refKey: xlsx.sheetKey, provider: 'google_drive', fileId: 'f1', sheet: 'Facturen' }, localColumn: { id: '1', title: 'Leverancier', type: 'text', col: 1 },
            to: { refKey: csv.sheetKey, provider: 'nextcloud_files', fileId: '4711', sheet: null }, targetColumn: { id: '0', title: 'Naam', type: 'text', col: 0 },
        }];
        const body = buildLinkBody({ scope: 'organisation', selection: new Map([[csv.sheetKey, csv], [xlsx.sheetKey, xlsx]]), relations });
        expect(body.tables[0].sheet).toBeNull();
        expect(body.relations[0].to.sheet).toBeNull();
        expect(JSON.stringify(body)).not.toMatch(/"null"/);
    });
});

describe('a csv\'s unnamed sheet', () => {
    it('keeps null as its identity in the keys, and the file\'s name as its label', () => {
        const s = newSelection(NC_FILE, null);
        expect(s.sheet).toBeNull();
        expect(s.sheetKey).toBe('nextcloud_files:4711#null');
        expect(s.sheetLabel).toBe('klanten.csv');
        expect(newSelection(FILE, 'Facturen').sheetLabel).toBe('Facturen');
    });

    it('sheetLabelOf never prints null, undefined or an empty name', () => {
        expect(sheetLabelOf(null, 'klanten.csv')).toBe('klanten.csv');
        expect(sheetLabelOf(undefined, 'klanten.csv')).toBe('klanten.csv');
        expect(sheetLabelOf('', 'klanten.csv')).toBe('klanten.csv');
        expect(sheetLabelOf('Blad2', 'klanten.csv')).toBe('Blad2');
        expect(sheetLabelOf(null, null)).toBe('');
    });
});

describe('stepForError', () => {
    const err = (code, body = {}) => Object.assign(new Error(code), { code, body });
    it('routes a taken technical name to the names step', () => {
        expect(stepForError(err('key_taken', { key: 'facturen' }))).toEqual({ step: 'names', key: 'facturen', fileKey: null, sheetKey: null });
    });
    it('routes a sheet the server would not read to the sheets step, marked by its ref', () => {
        const ref = { provider: 'google_drive', fileId: 'f1', sheet: 'Facturen' };
        for (const code of ['already_linked', 'key_not_unique', 'header_missing']) {
            expect(stepForError(err(code, { ref }))).toEqual({ step: 'sheets', key: null, fileKey: 'google_drive:f1', sheetKey: 'google_drive:f1#Facturen' });
        }
    });
    it('routes a storage refusal to the files step, marked by the file when the ref names one', () => {
        expect(stepForError(err('provider_not_connected', { ref: { provider: 'onedrive', fileId: 'o1' } })))
            .toEqual({ step: 'files', key: null, fileKey: 'onedrive:o1', sheetKey: null });
        expect(stepForError(err('spreadsheet_too_large', { provider: 'onedrive' }))).toMatchObject({ step: 'files', fileKey: null });
        expect(stepForError(err('format_unsupported'))).toMatchObject({ step: 'files' });
    });
    it('leaves the person where they are for anything it does not know', () => {
        expect(stepForError(err('quota_exceeded'))).toMatchObject({ step: null });
        expect(stepForError(null)).toMatchObject({ step: null });
    });
});

describe('ssReasonText', () => {
    it('names the storage in every reason it can', () => {
        expect(ssReasonText(t, { provider: 'onedrive', reason: 'needs_reauth' })).toMatch(/OneDrive connection has expired/);
        expect(ssReasonText(t, { provider: 'google_drive', reason: 'integration_off' })).toMatch(/^Google Drive is switched off/);
        expect(ssReasonText(t, { provider: 'google_drive', reason: 'not_connected' })).toMatch(/^Google Drive is not connected/);
        expect(ssReasonText(t, { provider: 'nextcloud_files', reason: 'nc_scope_denied' })).toMatch(/Nextcloud files yet/);
        expect(ssReasonText(t, { provider: 'onedrive', reason: 'something_new' })).toBe('OneDrive cannot be used just now.');
    });
    it('knows which refusals are about the connection', () => {
        expect(isProviderError({ code: 'provider_not_connected' })).toBe(true);
        expect(isProviderError({ code: 'spreadsheet_not_found' })).toBe(false);
    });
});

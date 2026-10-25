// @vitest-environment node
/**
 * Column-title matching for the Nextcloud Tables row steps.
 *
 * The contract in one line: spelling differences a person would not notice
 * (case, accents, dots, underscores, spaces) are ignored; anything else is a
 * guess and is NOT made. "excl_btw" reaches "Excl. btw"; "amount_total" does
 * not reach "Totaal", however obvious that looks to a human.
 *
 * The last block is a lockstep test: it reads the server's own
 * normaliseColumnKey out of server/integrations/nextcloudTablesTools.js and
 * runs the same corpus through both. The server resolves keys with that
 * function at run time, so if the two ever drift the editor would show
 * "matched" for a key the tool then rejects — or the other way round.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/automation/Builder/flow/settings/columnMatch.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchColumns, normaliseColumnKey, resolveKeyToColumn } from './columnMatch';

describe('normaliseColumnKey', () => {
    it('lower-cases and drops punctuation, spaces and underscores', () => {
        expect(normaliseColumnKey('Excl. btw')).toBe('exclbtw');
        expect(normaliseColumnKey('excl_btw')).toBe('exclbtw');
        expect(normaliseColumnKey('EXCL BTW')).toBe('exclbtw');
        expect(normaliseColumnKey('Excl.btw')).toBe('exclbtw');
    });

    it('strips diacritics', () => {
        expect(normaliseColumnKey('Überweisung')).toBe('uberweisung');
        expect(normaliseColumnKey('Prénom')).toBe('prenom');
        expect(normaliseColumnKey('Straße')).toBe('strae'); // ß is not a base letter + mark; it is dropped, as on the server
    });

    it('drops symbols and keeps digits', () => {
        expect(normaliseColumnKey('Prijs (€)')).toBe('prijs');
        expect(normaliseColumnKey('Q3 2026 — omzet')).toBe('q32026omzet');
    });

    it('is safe on nothing', () => {
        expect(normaliseColumnKey(null)).toBe('');
        expect(normaliseColumnKey(undefined)).toBe('');
        expect(normaliseColumnKey('---')).toBe('');
    });
});

describe('matchColumns', () => {
    const COLUMNS = ['Bedrijf', 'Excl. btw', 'Totaal', 'Datum', 'Status'];

    it('maps a field onto a column whose title differs only in spelling', () => {
        const r = matchColumns(['excl_btw', 'bedrijf', 'DATUM'], COLUMNS);
        expect(r.byColumn).toEqual({ 'Excl. btw': 'excl_btw', Bedrijf: 'bedrijf', Datum: 'DATUM' });
        expect(r.unmatchedFields).toEqual([]);
        expect(r.unmatchedColumns).toEqual(['Totaal', 'Status']);
    });

    it('does NOT guess beyond normalisation: amount_total stays unmapped', () => {
        const r = matchColumns(['amount_total', 'vat', 'company_name'], COLUMNS);
        expect(r.byColumn).toEqual({});
        expect(r.unmatchedFields).toEqual(['amount_total', 'vat', 'company_name']);
    });

    it('two columns that collapse onto one key are ambiguous — neither is matched', () => {
        const r = matchColumns(['btw'], ['Btw', 'BTW.', 'Totaal']);
        expect(r.byColumn).toEqual({});
        expect(r.ambiguous).toEqual(['Btw', 'BTW.']);
        expect(r.unmatchedFields).toEqual(['btw']);
    });

    it('two fields that collapse onto one column are ambiguous unless one is the exact title', () => {
        // No exact spelling among them → refuse, rather than pick one.
        const none = matchColumns(['excl_btw', 'ExclBtw'], ['Excl. btw']);
        expect(none.byColumn).toEqual({});
        expect(none.ambiguous).toEqual(['Excl. btw']);
        // The exact title wins over its aliases — the server's own tie-break.
        const exact = matchColumns(['excl_btw', 'excl. btw'], ['Excl. btw']);
        expect(exact.byColumn).toEqual({ 'Excl. btw': 'excl. btw' });
        expect(exact.unmatchedFields).toEqual(['excl_btw']);
    });

    it('a field is used at most once', () => {
        // One field, two DIFFERENT columns it could not both fill: only the
        // one it actually normalises to.
        const r = matchColumns(['status'], ['Status', 'Status (oud)']);
        expect(r.byColumn).toEqual({ Status: 'status' });
        expect(r.unmatchedColumns).toEqual(['Status (oud)']);
    });

    it('ignores empty names on either side', () => {
        const r = matchColumns(['', null, 'datum'], ['', 'Datum']);
        expect(r.byColumn).toEqual({ Datum: 'datum' });
        expect(r.unmatchedFields).toEqual([]);
        expect(r.unmatchedColumns).toEqual([]);
    });
});

describe('resolveKeyToColumn mirrors the run-time key lookup', () => {
    const cols = [
        { id: 12, title: 'Excl. btw' },
        { id: 13, title: 'Totaal' },
        { id: 14, title: 'Btw' },
        { id: 15, title: 'BTW.' },
    ];

    it('exact title, case-insensitively', () => {
        expect(resolveKeyToColumn('excl. BTW', cols)?.id).toBe(12);
    });

    it('a numeric column id', () => {
        expect(resolveKeyToColumn('13', cols)?.id).toBe(13);
    });

    it('a unique normalised key', () => {
        expect(resolveKeyToColumn('excl_btw', cols)?.id).toBe(12);
    });

    it('an ambiguous normalised key resolves to nothing', () => {
        expect(resolveKeyToColumn('btw_', cols)).toBeNull();
        // …but the exact spelling of either still wins.
        expect(resolveKeyToColumn('BTW.', cols)?.id).toBe(15);
        expect(resolveKeyToColumn('btw', cols)?.id).toBe(14);
    });

    it('an unknown key resolves to nothing', () => {
        expect(resolveKeyToColumn('amount_total', cols)).toBeNull();
        expect(resolveKeyToColumn('', cols)).toBeNull();
    });
});

describe('the client normaliser is the server one', () => {
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const SERVER_FILE = path.resolve(HERE, '../../../../../../../server/integrations/nextcloudTablesTools.js');
    const exists = fs.existsSync(SERVER_FILE);

    // The server module is read as TEXT and only the one function is
    // evaluated: requiring it would boot a config store and a database pool
    // into a frontend test. The match is on the function's own body, so a
    // renamed or moved function fails loudly rather than passing vacuously.
    function serverNormaliser() {
        const src = fs.readFileSync(SERVER_FILE, 'utf8');
        const m = /function normaliseColumnKey\(title\) \{[\s\S]*?\n\}/.exec(src);
        if (!m) throw new Error('normaliseColumnKey not found in the server file');
        return new Function(`${m[0]}; return normaliseColumnKey;`)();
    }

    it.skipIf(!exists)('agrees with the server on a corpus of titles and field names', () => {
        const server = serverNormaliser();
        const corpus = [
            'Excl. btw', 'excl_btw', 'EXCL BTW', 'Excl.btw', 'Totaal', 'amount_total',
            'Überweisung', 'Prénom', 'Straße', 'Prijs (€)', 'Q3 2026 — omzet', 'Datum/tijd',
            'naam-klant', 'e-mail', 'E‑mail', '日本語', 'Ärger', '', '   ', '---', 'ID', 'id_2',
            'Company name', 'company_name', 'companyName', 'Status (oud)', 'BTW.',
        ];
        for (const s of corpus) expect(normaliseColumnKey(s), s).toBe(server(s));
    });

    it.skipIf(!exists)('the server file names this module as its mirror', () => {
        // If the comment goes, the mirror is no longer a documented contract
        // and the next person to touch either side will not know to touch both.
        const src = fs.readFileSync(SERVER_FILE, 'utf8');
        expect(src).toContain('columnMatch.js');
    });
});

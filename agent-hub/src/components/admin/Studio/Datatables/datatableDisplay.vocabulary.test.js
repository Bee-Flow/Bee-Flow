/**
 * The pinning test datatableDisplay.js says it has.
 *
 * That module duplicates the server's grammar — KEY_RE, SYSTEM_COLUMNS, the
 * type list, the two caps, the managed-column contract — because the client
 * cannot require from server/, and its comments claim "the pinning test asserts
 * the two sources agree so the copy can never drift into being more
 * permissive". Until this file existed that claim was false: the neighbouring
 * datatableDisplay.test.js re-declares the same literals INSIDE itself, so it
 * passed whatever either source happened to say.
 *
 * So this one reads the real server files. It is a `fs`/`createRequire` test
 * for the reason server/routes/datatables.dialect.test.js is: the invariant is
 * "these two files agree", and no amount of behavioural testing on one side can
 * see the other move.
 *
 * WHICH DIRECTION MATTERS: a client copy that is MORE permissive lets a person
 * fill in a form the server then refuses; a client copy that is LESS permissive
 * hides a column type or a name length the product actually supports. Both are
 * caught here because equality is asserted, not containment.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
    COLUMN_TYPES, DEFINITION_MANAGED_KINDS, KEY_RE, MANAGED_COLUMNS, MAX_FIELDS_PER_TABLE, MAX_NAME_LEN,
    SOURCE_MANAGED_KINDS, SYSTEM_COLUMNS, managedColumnProblem, validateColumns,
} from './datatableDisplay';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, '../../../../../../server');

const vocabulary = require(path.join(SERVER, 'core/dataEngine/dataModel/vocabulary.js'));
const { DATATABLE_FIELD_TYPES } = require(path.join(SERVER, 'core/dataEngine/dataModel/datatableFields.js'));
const managedTables = require(path.join(SERVER, 'core/dataEngine/dataModel/managedTables.js'));

describe('the client copy of the column grammar is the server one', () => {
    it('KEY_RE is character-for-character the server pattern', () => {
        // `.source` and `.flags` rather than a loose behavioural sample: two
        // patterns can agree on every example anyone thinks to write down and
        // still differ on the 64th character, which is exactly the boundary
        // Postgres truncates at.
        expect(KEY_RE.source).toBe(vocabulary.KEY_RE.source);
        expect(KEY_RE.flags).toBe(vocabulary.KEY_RE.flags);
    });

    it('SYSTEM_COLUMNS is the same list, and in the same order', () => {
        expect(SYSTEM_COLUMNS).toEqual([...vocabulary.SYSTEM_COLUMNS]);
    });

    it('the offered types are exactly the ones a datatable field may have', () => {
        // The server's DATATABLE_FIELD_TYPES is FIELD_TYPES minus `relation`
        // and `computed`; the dropdown must offer that set and nothing else.
        // Offering `relation` would be an empty target picker; omitting `file`
        // would hide a type the API accepts.
        expect(COLUMN_TYPES.map(t => t.type).sort()).toEqual([...DATATABLE_FIELD_TYPES].sort());
        expect(DATATABLE_FIELD_TYPES).not.toContain('relation');
        expect(DATATABLE_FIELD_TYPES).not.toContain('computed');
    });

    it('every offered type carries a label and a blurb — an empty option is a dead end', () => {
        for (const t of COLUMN_TYPES) {
            expect(t.label, `${t.type} has no label`).toBeTruthy();
            expect(t.blurb, `${t.type} has no blurb`).toBeTruthy();
        }
    });

    it('the two caps are the server caps', () => {
        expect(MAX_FIELDS_PER_TABLE).toBe(vocabulary.DATA_LIMITS.MAX_FIELDS_PER_TABLE);
        expect(MAX_NAME_LEN).toBe(vocabulary.DATA_LIMITS.MAX_NAME_LEN);
    });

    it('validateColumns refuses a key one character past the server grammar', () => {
        // The cap that matters is Postgres's 63-byte identifier limit, and the
        // form is the only place a person meets it before a 400.
        const ok = `a${'b'.repeat(62)}`;
        const tooLong = `a${'b'.repeat(63)}`;
        expect(vocabulary.KEY_RE.test(ok)).toBe(true);
        expect(vocabulary.KEY_RE.test(tooLong)).toBe(false);
        expect(validateColumns([{ key: ok, name: 'ok', type: 'text' }])).toEqual([]);
        expect(validateColumns([{ key: tooLong, name: 'no', type: 'text' }]).length).toBeGreaterThan(0);
    });
});

describe('the client copy of the managed-column contract is the server one', () => {
    it('names the same kinds', () => {
        expect(Object.keys(MANAGED_COLUMNS).sort())
            .toEqual(Object.keys(managedTables.MANAGED_KINDS).sort());
    });

    it('locks the same columns, with the same types and the same unique/required flags', () => {
        for (const [kind, spec] of Object.entries(managedTables.MANAGED_KINDS)) {
            expect(MANAGED_COLUMNS[kind].map(f => f.key)).toEqual(spec.fields.map(f => f.key));
            for (const want of spec.fields) {
                const mine = MANAGED_COLUMNS[kind].find(f => f.key === want.key);
                expect(mine.type, `${kind}.${want.key} type`).toBe(want.type);
                expect(!!mine.unique, `${kind}.${want.key} unique`).toBe(!!want.unique);
                expect(!!mine.required, `${kind}.${want.key} required`).toBe(!!want.required);
            }
        }
    });

    it('refuses exactly the edits the server refuses, and allows the ones it allows', () => {
        // The whole point of the mirror: for each mutation of the contract,
        // both sides must answer the same yes/no. A sentence is not compared —
        // the client's is a translated string — but a refusal is.
        for (const [kind, spec] of Object.entries(managedTables.MANAGED_KINDS)) {
            const intact = spec.fields.map(f => ({ ...f }));
            // A kind whose WHOLE list is the source's has no first column to
            // mutate; for it the two cases that exist are the whole story —
            // and both must be refused on both sides (§ isSchemaLocked).
            const cases = [
                ['unchanged', intact],
                ['plus an author column', [...intact, { key: 'my_note', name: 'Note', type: 'text' }]],
                ...(spec.fields.length ? [
                    ['dropped', intact.filter(f => f.key !== spec.fields[0].key)],
                    ['renamed', intact.map(f => (f.key === spec.fields[0].key ? { ...f, key: 'renamed' } : f))],
                    ['retyped', intact.map(f => (f.key === spec.fields[0].key ? { ...f, type: 'number' } : f))],
                    ['un-uniqued', intact.map(f => (f.unique ? { ...f, unique: false } : f))],
                    ['un-required', intact.map(f => (f.required ? { ...f, required: false } : f))],
                ] : []),
            ];
            expect(SOURCE_MANAGED_KINDS.includes(kind), `${kind}: fieldsFromSource`).toBe(!!spec.fieldsFromSource);
            expect(DEFINITION_MANAGED_KINDS.includes(kind), `${kind}: fieldsFromDefinition`).toBe(!!spec.fieldsFromDefinition);
            for (const [label, fields] of cases) {
                const server = managedTables.managedFieldsError(kind, fields);
                const client = managedColumnProblem(kind, fields);
                expect(!!client, `${kind}: ${label} — client says ${client ? 'refuse' : 'allow'}, server says ${server ? 'refuse' : 'allow'}`)
                    .toBe(!!server);
            }
        }
    });

    it('says nothing at all about an ordinary table', () => {
        // NULL managedKind is the overwhelming majority. A mirror that fired on
        // it would lock every author's own columns.
        expect(managedColumnProblem(null, [])).toBeNull();
        expect(managedColumnProblem(undefined, [{ key: 'anything', type: 'text' }])).toBeNull();
        expect(managedTables.managedFieldsError(null, [])).toBeNull();
    });
});

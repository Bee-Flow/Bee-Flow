/**
 * bindingGuard's checks for a read through a relation (a records binding's
 * `expand`, a `<relation field>.<field>` filter, a grid column on an expanded
 * row): every name is checked against the table it belongs to, the bound table
 * or the one the relation points at. The findings go into the guard's own
 * list, in its shape.
 */

import { createRequire } from 'node:module';
import { pickClosestId } from '../../utils/closestId.mts';

const nodeRequire = createRequire(import.meta.url);

type Field = { key?: string; type?: string; relation?: { table?: string } };
type Table = { id?: string; key?: string; fields?: Field[] };
type Entry = Record<string, unknown>;
type GuardError = { index: number; path: string; suggestion: string | null; message: string; hint: string };
type FieldCheck = (index: number, path: string, table: Table, key: unknown, what: string) => void;

const { expandAlias } = nodeRequire('../validate/relationReadChecks.mts') as { expandAlias(entry: Entry): string | null };
const { EXPAND_LABEL_KEY } = nodeRequire('../../core/dataEngine/dataModel/vocabulary') as { EXPAND_LABEL_KEY: string };

const isObject = (v: unknown): v is Entry => v !== null && typeof v === 'object' && !Array.isArray(v);
const fieldsOf = (table: Table): Field[] => (Array.isArray(table.fields) ? table.fields : []).filter((f) => !!f);
const relationKeys = (table: Table): string[] => fieldsOf(table).filter((f) => f.type === 'relation').map((f) => f.key as string);

export function relationChecks({ byRef, errors, fieldCheck }: { byRef: Map<unknown, Table>; errors: GuardError[]; fieldCheck: FieldCheck }) {
    /** The table a relation field of `table` points at, or null. */
    const relationTarget = (table: Table, key: unknown): Table | null => {
        const relation = fieldsOf(table).find((f) => f.key === key && f.type === 'relation');
        return (relation && relation.relation && byRef.get(relation.relation.table)) || null;
    };

    /**
     * `<relation field>.<field of the related table>` (a filter through a relation): the head must
     * be a relation field of `table` and the tail a field of the table it points at. False for a
     * plain name, which the caller checks.
     */
    const throughRelation = (index: number, path: string, table: Table, key: unknown, what: string): boolean => {
        if (typeof key !== 'string' || !key.includes('.')) return false;
        const [head, tail, more] = key.split('.');
        const target = relationTarget(table, head);
        if (!target || !tail || more !== undefined) {
            errors.push({
                index, path, suggestion: null,
                message: `${what} names ${JSON.stringify(key)}, which is not <relation field>.<field of the related table> on table ${table.id} (${table.key}).`,
                hint: `Relation fields on ${table.key}: ${relationKeys(table).join(', ') || '(none)'}. A read goes one relation deep.`,
            });
            return true;
        }
        fieldCheck(index, path, target, tail, what);
        return true;
    };

    /** One `expand` entry: a relation field of `table`, and picked fields of the table it points at. */
    const checkExpandEntry = (index: number, path: string, table: Table, e: Entry): void => {
        const target = relationTarget(table, e.field);
        if (!target) {
            const relations = relationKeys(table);
            errors.push({
                index, path: `${path}.field`, suggestion: pickClosestId(e.field, relations) || null,
                message: `expand names ${JSON.stringify(e.field)}, which is not a relation field of table ${table.id} (${table.key}) to another table of this app.`,
                hint: `Relation fields on ${table.key}: ${relations.join(', ') || '(none)'}.`,
            });
            return;
        }
        (Array.isArray(e.pick) ? e.pick : []).forEach((k, j) => fieldCheck(index, `${path}.pick[${j}]`, target, k, 'expand pick'));
    };

    /** `expand` and `fields` of a binding. */
    const checkRelationRead = (index: number, path: string, table: Table, b: Entry): void => {
        (Array.isArray(b.fields) ? b.fields : []).forEach((k, i) => fieldCheck(index, `${path}.fields[${i}]`, table, k, `${b.kind} fields`));
        (Array.isArray(b.expand) ? b.expand : []).forEach((e, i) => { if (isObject(e)) checkExpandEntry(index, `${path}.expand[${i}]`, table, e); });
    };

    /**
     * A grid column that reads an expansion of the grid's binding: the expansion itself (shown by
     * its display field) or `<expansion>.<field of the related table>`. False for a plain column
     * key, which the caller checks against the bound table.
     */
    const expandedColumn = (index: number, path: string, table: Table, data: Entry, key: string): boolean => {
        const expansions = (Array.isArray(data.expand) ? data.expand : []).filter(isObject);
        if (expansions.some((e) => expandAlias(e) === key)) return true;
        if (!key.includes('.')) return false;
        const [head, tail] = key.split('.');
        const entry = expansions.find((e) => expandAlias(e) === head);
        const target = entry ? relationTarget(table, entry.field) : null;
        if (!target) {
            errors.push({
                index, path, suggestion: null,
                message: `grid column ${JSON.stringify(key)} reads a related row, but the grid's binding has no expand named ${JSON.stringify(head)}.`,
                hint: 'Add expand: [{ field: <relation field>, pick: [<fields>] }] to the binding; the related row then sits under <relation field>_record (or the entry\'s `as`), e.g. column key "customer_record.name".',
            });
            return true;
        }
        if (tail !== EXPAND_LABEL_KEY) fieldCheck(index, path, target, tail, 'grid column');
        return true;
    };

    return { throughRelation, checkRelationRead, expandedColumn };
}

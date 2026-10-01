// The datatable node's settings panel.
//
// The rule that shapes every control here: NOTHING IS FREE TEXT. The table is
// picked from a list the server already filtered by what this user may use; a
// column is picked from that table's own declared fields; the test comes from a
// closed operator list; only the VALUE is a binding. That is what makes "no
// client SQL" true end to end rather than merely intended — there is no input
// whose contents could become an identifier.
import { useMemo } from 'react';
import { Table2 } from 'lucide-react';
import FieldKeyCombobox from '../../mapping/FieldKeyCombobox';
import ValueSlot from '../../valueSlot/ValueSlot';
import { columnTypeKind, opTakesList, opTakesNoValue } from '../../../../admin/Studio/Datatables/datatableDisplay';
import AccordionSection from '../AccordionSection';
import { ForEachSection, RetrySection, retryIsSet } from './collectionEditors';
import { controlSurfaceClass, FormRow, inputClass } from './formPrimitives';

// Mirrors core/dataEngine FILTER_OPS. Labelled in the words a person would use,
// and narrowed per column type so a date never offers "contains".
const OPS = [
    { op: 'eq', label: 'is' },
    { op: 'neq', label: 'is not' },
    { op: 'contains', label: 'contains' },
    { op: 'notContains', label: 'does not contain' },
    { op: 'startsWith', label: 'starts with' },
    { op: 'endsWith', label: 'ends with' },
    { op: 'gt', label: 'is more than' },
    { op: 'gte', label: 'is at least' },
    { op: 'lt', label: 'is less than' },
    { op: 'lte', label: 'is at most' },
    { op: 'in', label: 'is one of' },
    { op: 'notIn', label: 'is none of' },
    { op: 'between', label: 'is between' },
    { op: 'isNull', label: 'is empty' },
    { op: 'isNotNull', label: 'is not empty' },
];
const TEXTUAL = new Set(['text', 'richtext', 'select', 'multiselect', 'relation', 'file']);
const ORDERED = new Set(['number', 'date', 'datetime']);
const TEXT_ONLY = ['contains', 'notContains', 'startsWith', 'endsWith'];

function opsForType(type) {
    if (!type) return OPS;
    if (TEXTUAL.has(type)) return OPS.filter(o => !['gt', 'gte', 'lt', 'lte', 'between'].includes(o.op));
    if (ORDERED.has(type)) return OPS.filter(o => !TEXT_ONLY.includes(o.op));
    if (type === 'bool') return OPS.filter(o => ['eq', 'neq', 'isNull', 'isNotNull'].includes(o.op));
    return OPS;
}

export default function DatatableFields({
    draft, set, groups, onFocusField, previewSample,
    errorSections = new Set(), catalog = null,
}) {
    const tables = useMemo(() => (catalog?.datatables || []), [catalog]);
    const ops = useMemo(() => (catalog?.datatableOps || []), [catalog]);
    const table = useMemo(
        () => tables.find(t => t.id === draft.datatableId) || null,
        [tables, draft.datatableId],
    );
    const columns = useMemo(() => table?.columns || [], [table]);
    const columnOptions = useMemo(
        () => columns.map(c => ({ value: c.key, label: c.name || c.key })),
        [columns],
    );
    const typeOf = (key) => columns.find(c => c.key === key)?.type || null;

    const op = draft.op || 'find_rows';
    // count_rows READS — it is not a write, and it needs no values and no
    // limit: it answers how many rows match, which is exactly the number
    // find_rows cannot give (its `returned` is clamped by the page size).
    const writes = op !== 'find_rows' && op !== 'count_rows';
    const needsValues = writes && op !== 'delete_rows';
    const needsMatch = op === 'save_row';
    const needsWhere = op === 'update_rows' || op === 'delete_rows';

    const where = Array.isArray(draft.where) ? draft.where : [];
    const setWhere = (next) => set('where', next);
    const values = (draft.values && typeof draft.values === 'object') ? draft.values : {};
    // compileRecordList honours sort[0] ONLY, so the control offers ONE column.
    // A second entry would read as "sorted by two columns" and be ignored.
    const sortEntry = (Array.isArray(draft.sort) ? draft.sort : [])[0] || null;
    const setSort = (field, dir) => set('sort', field ? [{ field, dir: dir || 'desc' }] : []);

    return (
        <>
            <AccordionSection
                stepType="datatable" sectionKey="table" title="Table" defaultOpen
                forceOpen={errorSections.has('table')}
            >
                <FormRow
                    label="Datatable"
                    hint="Rows in a datatable stay put after the run ends, so this routine can read back what an earlier run wrote — and other routines can use the same table."
                >
                    {tables.length === 0 ? (
                        // Never a bare empty dropdown. An empty state that does
                        // not say why reads as "broken", and the palette's own
                        // comment about answering "you can't have this" with
                        // silence applies just as much here.
                        //
                        // And what it says has to be TRUE. This read "An
                        // administrator creates them in Studio → Datatables",
                        // with no link: a locked door with somebody else's name
                        // on it. The server has never agreed. POST
                        // /api/datatables (routes/datatables/tables.js) gates
                        // only the ORGANISATION scope, and only on
                        // `manage_datatables`; the personal scope needs nothing
                        // but a session — "the org-scope gate, and only here",
                        // as the route itself puts it. So the dead end sent a
                        // person to a colleague who could not help them either,
                        // over a table they were free to make themselves. A
                        // false locked door costs MORE than silence: silence
                        // leaves you searching, a false attribution ends the
                        // search at the wrong desk.
                        //
                        // The link opens Studio in a new tab rather than
                        // navigating away — this panel sits over a canvas whose
                        // edits are not saved yet, and losing the routine on the
                        // way to fetch a table for it is the same complaint
                        // twice. HttpAuthPicker's "Manage credentials in
                        // Settings" is the same shape for the same reason.
                        //
                        // The permission is NAMED in words and kept exactly in
                        // the tooltip: the person reading this needs the
                        // sentence, and the administrator they forward it to
                        // needs the string to grant.
                        <div className="text-xs text-slate-500 dark:text-slate-400 flex items-start gap-2 py-1">
                            <Table2 size={14} className="mt-0.5 shrink-0" />
                            <span>
                                No datatables yet. You can make one yourself in{' '}
                                <a
                                    href="/app/studio/datatables"
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-sky-700 dark:text-sky-400 hover:underline"
                                >
                                    Studio &rarr; Datatables
                                </a>
                                {' '}— a table for this account alone needs no permission; one the whole
                                organisation can use needs{' '}
                                <span title="manage_datatables" className="underline decoration-dotted">
                                    a permission an administrator grants
                                </span>. It appears in this list as soon as it exists.
                            </span>
                        </div>
                    ) : (
                        <select
                            className={inputClass()}
                            value={draft.datatableId || ''}
                            onChange={(e) => set('datatableId', e.target.value)}
                            onFocus={() => onFocusField?.('datatableId')}
                        >
                            <option value="">Pick a table…</option>
                            {tables.map(t => (
                                <option key={t.id} value={t.id} disabled={writes && !t.canWrite}>
                                    {t.name}
                                    {t.managedKind === 'nextcloud_table' ? ' · from Nextcloud' : t.managedKind === 'spreadsheet_file' ? ' · from a spreadsheet' : ''}
                                    {t.scope !== 'personal' ? ' · shared' : ''}
                                    {writes && !t.canWrite ? ' — you can only read this one' : ''}
                                </option>
                            ))}
                        </select>
                    )}
                </FormRow>

                <FormRow label="What to do" hint={ops.find(o => o.op === op)?.blurb || ''}>
                    <select
                        className={inputClass()}
                        value={op}
                        onChange={(e) => set('op', e.target.value)}
                        onFocus={() => onFocusField?.('op')}
                    >
                        {(ops.length ? ops : [{ op: 'find_rows', label: 'Find rows' }]).map(o => (
                            <option key={o.op} value={o.op}>{o.label}</option>
                        ))}
                    </select>
                </FormRow>

                {table && table.scope !== 'personal' && writes && (
                    <p className="text-[11px] text-amber-700 dark:text-amber-400 px-1">
                        This table is shared — other people and other routines read what this step writes.
                    </p>
                )}
            </AccordionSection>

            <AccordionSection
                stepType="datatable" sectionKey="match"
                title={needsWhere ? 'Which rows (required)' : 'Which rows'}
                defaultOpen={needsWhere || where.length > 0}
                forceOpen={errorSections.has('match')}
            >
                {needsMatch && (
                    <FormRow
                        label="Match on"
                        hint="The column that decides whether a row already exists. If a row has the same value here it is updated; otherwise a new row is added."
                    >
                        <FieldKeyCombobox
                            value={draft.matchColumn || ''}
                            onChange={(v) => set('matchColumn', v)}
                            options={columnOptions}
                            placeholder="email"
                            label="Match on"
                            onFocusField={onFocusField}
                        />
                    </FormRow>
                )}

                {needsWhere && where.length === 0 && (
                    <p className="text-[11px] text-rose-700 dark:text-rose-400 px-1 pb-1">
                        Add at least one condition. Without one this would change every row in the table.
                    </p>
                )}

                {where.length > 1 && (
                    <FormRow
                        label="Combine with"
                        hint={needsWhere
                            ? 'With "any", a row is changed when it matches ONE of these — a single broad condition then decides the whole write.'
                            : 'All of them (the default), or any one of them.'}
                    >
                        <select
                            className={inputClass()}
                            value={draft.match || 'all'}
                            onChange={(e) => set('match', e.target.value === 'any' ? 'any' : 'all')}
                        >
                            <option value="all">All of these conditions</option>
                            <option value="any">Any one of these conditions</option>
                        </select>
                    </FormRow>
                )}

                <div className="space-y-2">
                    {where.map((w, i) => {
                        const colType = typeOf(w?.field);
                        const allowed = opsForType(colType);
                        return (
                            <div key={i} className={`${controlSurfaceClass} p-2 space-y-1.5`}>
                                <div className="flex gap-1.5">
                                    <div className="flex-1 min-w-0">
                                        <FieldKeyCombobox
                                            value={w?.field || ''}
                                            onChange={(v) => setWhere(where.map((x, j) => (j === i ? { ...x, field: v } : x)))}
                                            options={columnOptions}
                                            placeholder="column"
                                            label="Column"
                                            onFocusField={onFocusField}
                                        />
                                    </div>
                                    <select
                                        className={`${inputClass} w-32 shrink-0`}
                                        value={w?.op || 'eq'}
                                        onChange={(e) => setWhere(where.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}
                                    >
                                        {allowed.map(o => <option key={o.op} value={o.op}>{o.label}</option>)}
                                    </select>
                                    <button
                                        type="button"
                                        className="text-xs text-slate-500 hover:text-rose-600 px-1 shrink-0"
                                        onClick={() => setWhere(where.filter((_, j) => j !== i))}
                                        aria-label="Remove this condition"
                                    >
                                        Remove
                                    </button>
                                </div>
                                {/* `isNull`/`isNotNull` are the whole condition on
                                    their own — opTakesNoValue is the shared answer
                                    to "does this operator still want a value?". */}
                                {!opTakesNoValue(w?.op) && (
                                    <ValueSlot
                                        value={w?.value}
                                        onChange={(v) => setWhere(where.map((x, j) => (j === i ? { ...x, value: v } : x)))}
                                        label="Value"
                                        showChrome
                                        placeholder="a value, or drag one in from an earlier step"
                                        onFocusField={onFocusField}
                                        previewSample={previewSample}
                                        // What this comparison wants comes from the
                                        // COLUMN and the OPERATOR, not from a guess:
                                        // `is one of` takes a list, `is` takes one
                                        // value, and a `select` column takes one of
                                        // its declared options.
                                        //
                                        // Which operators those are is NOT restated
                                        // here: opTakesList is the same list the
                                        // datatable filter itself compiles against, so
                                        // the two can never drift apart. It matters
                                        // because binding a list to `in`/`notIn`/
                                        // `between` is CORRECT — the value editor must
                                        // not ask "this wants one value, what did you
                                        // mean?" about it, a question the author cannot
                                        // answer without making the filter wrong.
                                        expectKind={opTakesList(w?.op) ? 'list' : (columnTypeKind(colType) || 'text')}
                                    />
                                )}
                            </div>
                        );
                    })}
                    <button
                        type="button"
                        className="text-xs text-sky-700 dark:text-sky-400 hover:underline"
                        onClick={() => setWhere([...where, { field: '', op: 'eq', value: '' }])}
                    >
                        + Add a condition
                    </button>
                </div>

                {op === 'find_rows' && (
                    <>
                        {/* `sort` was read by the executor, allowlisted for
                            patching and collected by the usage index — and
                            appeared in NO ui, so "the 5 most recent" was
                            reachable only by hand-editing JSON. */}
                        <FormRow
                            label="Order by"
                            hint="One column decides the order; rows with the same value fall back to the order they were added. Newest first when left empty."
                        >
                            <div className="flex gap-1.5">
                                <div className="flex-1 min-w-0">
                                    <FieldKeyCombobox
                                        value={sortEntry?.field || ''}
                                        onChange={(v) => setSort(v, sortEntry?.dir)}
                                        options={columnOptions}
                                        placeholder="added on (default)"
                                        label="Order by"
                                        onFocusField={onFocusField}
                                    />
                                </div>
                                <select
                                    className={`${inputClass} w-32 shrink-0`}
                                    value={sortEntry?.dir || 'desc'}
                                    disabled={!sortEntry?.field}
                                    onChange={(e) => setSort(sortEntry?.field, e.target.value)}
                                    aria-label="Sort direction"
                                >
                                    <option value="desc">highest first</option>
                                    <option value="asc">lowest first</option>
                                </select>
                            </div>
                        </FormRow>

                        <FormRow
                            label="At most"
                            hint="How many rows ONE page brings back. The default is 50; the step also hands back a cursor so a later step can read the next page."
                        >
                            <input
                                type="number" min={1} max={1000}
                                className={inputClass()}
                                value={draft.limit ?? 50}
                                onChange={(e) => set('limit', Number(e.target.value))}
                            />
                        </FormRow>
                    </>
                )}
            </AccordionSection>

            {needsValues && (
                <AccordionSection
                    stepType="datatable" sectionKey="values" title="What to write" defaultOpen
                    forceOpen={errorSections.has('values')}
                >
                    {columns.length === 0 ? (
                        <p className="text-xs text-slate-500 dark:text-slate-400 px-1">
                            Pick a table first — its columns appear here.
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {columns.map((c) => {
                                // The column's DECLARED type is the whole point of
                                // this panel: a `multiselect` really does take a
                                // list, and a `text` column asked to hold one is
                                // the write that reaches the row as
                                // "[object Object]".
                                const kind = columnTypeKind(c.type);
                                return (
                                    <ValueSlot
                                        key={c.key}
                                        fieldId={c.key}
                                        field={c.key}
                                        value={values[c.key]}
                                        onChange={(v) => set('values', { ...values, [c.key]: v })}
                                        label={c.name || c.key}
                                        showChrome
                                        placeholder={`leave empty to skip ${c.name || c.key}`}
                                        onFocusField={onFocusField}
                                        previewSample={previewSample}
                                        expectKind={kind}
                                    />
                                );
                            })}
                        </div>
                    )}
                </AccordionSection>
            )}

            {/* Iteration: one write (or lookup) per item of an upstream list —
                the validator allows forEach on datatable steps since 2026-09-04. */}
            <AccordionSection
                stepType="datatable" sectionKey="advanced" title="Advanced"
                forceOpen={errorSections.has('advanced')} hasContent={!!draft.forEach || retryIsSet(draft)}
            >
                <FormRow label="Iteration" hint="Off by default: the step runs once. Turn on to run it once per item of an upstream list (then reference {{loop.item…}} in the conditions and values).">
                    <ForEachSection draft={draft} set={set} groups={groups} onFocusField={onFocusField} />
                </FormRow>
                <RetrySection draft={draft} set={set} />
            </AccordionSection>
        </>
    );
}

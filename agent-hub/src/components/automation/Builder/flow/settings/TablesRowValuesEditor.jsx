// The `values` input of the Nextcloud Tables row steps, one row per column.
//
// The step writes `{ "<Column title>": <value> }` — a map keyed by the
// table's OWN column titles, resolved by the tool at run time. Declared as a
// plain `object` in the tool schema, that input fell through to the generic
// editor as a raw JSON box holding `{"vat":{"kind":"ref",…}}`: a person cannot
// fill that in, and the AI keyed it by its own field names, so the row failed
// with "Unknown column(s)…" (2026-09-12).
//
// This editor reads the table's columns and draws a labelled slot for each,
// with the same ValueBuilder every other value slot uses. What it EMITS is the
// exact shape the tool expects — the plain map, nested bindings and all,
// never a JSON string — so the runtime (bind.js resolveDeep) and the validator
// see nothing new. Unmapped columns are simply absent: not written.
//
// Where the columns come from, in order:
//   1. a literal tableId → GET /api/automation/catalog/nextcloud-tables/:id/columns
//      (the same answer nextcloud_tables_list_columns gives — see
//      tablesRowValues.loadTableColumns; swap it through the `loadColumns` prop);
//   2. no literal tableId (bound from a step), or the read failed → the
//      author types the titles, and the panel says why it is asking.
//
// The value model (reading the stored shape, placing keys on columns, the
// Auto-map candidates) is ./tablesRowValues.js; title matching is
// ./columnMatch.js, which the server mirrors.
import { RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { EmptySlotNote } from '../../mapping/fieldChrome';
import FieldKindIcon from '../../mapping/FieldKindIcon';
import { isEmptyBinding } from '../../mapping/partitionInputs';
import ValueBuilder from '../../mapping/ValueBuilder';
import { useVariablePickerContext } from '../../mapping/VariablePickerContext';
import FieldHint from '../FieldHint';
import { matchColumns } from './columnMatch';
import { SectionNote } from './formPrimitives';
import {
    actionButtonClass, cardClass, denseInputClass, fieldLabelClass, hintTextClass,
    INLINE_LINK, listBadgeClass, requiredChipClass, subLabelClass,
} from './formStyles';
import {
    candidateFields, columnKind, feedingGroup, literalTableId, loadTableColumns, mappableGroups,
    normaliseColumn, parseTitleList, placeKeys, readValuesMap, TYPE_LABEL, TYPE_LABEL_UNKNOWN,
} from './tablesRowValues';

/**
 * The table's columns for a literal id. `status` is DERIVED from whether the
 * latest answer belongs to the current request, so no state is written
 * synchronously inside the effect: 'idle' (no literal id), 'loading', 'ok',
 * 'error'. `retry` re-asks for the same id.
 */
function useTableColumns(literalId, loadColumns) {
    const [attempt, setAttempt] = useState(0);
    const requestKey = literalId == null ? null : `${literalId}:${attempt}`;
    const [answer, setAnswer] = useState(null); // { key, columns, error }
    useEffect(() => {
        if (requestKey == null) return undefined;
        let alive = true;
        Promise.resolve()
            .then(() => loadColumns(literalId))
            .then(
                (list) => { if (alive) setAnswer({ key: requestKey, columns: list, error: null }); },
                (e) => { if (alive) setAnswer({ key: requestKey, columns: [], error: e?.message || 'unknown error' }); },
            );
        return () => { alive = false; };
    }, [requestKey, literalId, loadColumns]);
    const current = answer && answer.key === requestKey ? answer : null;
    let status = 'idle';
    if (requestKey != null) status = current ? (current.error ? 'error' : 'ok') : 'loading';
    return {
        status,
        columns: current?.columns || [],
        error: current?.error || null,
        retry: () => setAttempt(a => a + 1),
    };
}

export default function TablesRowValuesEditor({
    step = null,
    tool = null,
    value,
    onChange,
    tableId,
    catalog = null, // accepted for parity with the other editors; the columns come from the table itself
    groups = null,
    onFocusField = null,
    previewSample = null,
    loadColumns = loadTableColumns,
    allowRaw = true,
}) {
    void catalog;
    const { t } = useTranslation();
    const pickerCtx = useVariablePickerContext();
    const upstream = useMemo(() => groups || pickerCtx.groups || [], [groups, pickerCtx.groups]);
    const currentTool = tool || step?.tool || null;
    const creating = currentTool === 'nextcloud_tables_create_row';

    const literalId = literalTableId(tableId);
    const { map, whole } = useMemo(() => readValuesMap(value), [value]);
    const cols = useTableColumns(literalId, loadColumns);
    const fetched = cols.status === 'ok';

    // Manual titles live here until a value is bound under them — then the
    // key lives in `value` and is drawn from there.
    const [manualTitles, setManualTitles] = useState([]);
    const columns = useMemo(() => {
        if (fetched) return cols.columns;
        // Manual mode: every stored key IS a column as far as we can tell,
        // plus whatever the author typed.
        const known = Object.keys(map).map(title => normaliseColumn({ title })).filter(c => c.title);
        const extra = manualTitles
            .filter(title => !known.some(c => c.title.toLowerCase() === title.toLowerCase()))
            .map(title => normaliseColumn({ title }));
        return [...known, ...extra];
    }, [fetched, cols.columns, map, manualTitles]);

    const { keyForColumn, stray } = useMemo(() => placeKeys(map, columns), [map, columns]);
    const cellBinding = (col) => (keyForColumn[col.title] !== undefined ? map[keyForColumn[col.title]] : undefined);

    const emit = (next) => onChange?.(next);
    const setCell = (col, binding) => {
        const next = { ...map };
        const existingKey = keyForColumn[col.title];
        if (existingKey !== undefined && existingKey !== col.title) delete next[existingKey];
        if (isEmptyBinding(binding)) delete next[col.title];
        else next[col.title] = binding;
        emit(next);
    };
    const removeStray = (key) => {
        const next = { ...map };
        delete next[key];
        emit(next);
    };

    if (whole) {
        return (
            <WholeRowSlot
                t={t} value={whole} onChange={onChange} onFocusField={onFocusField}
                previewSample={previewSample} allowRaw={allowRaw}
                onSplit={() => emit({})}
            />
        );
    }

    const slotProps = { onFocusField, previewSample, allowRaw };
    return (
        <div className="space-y-2" data-testid="tables-row-values">
            <ModeNote t={t} literalId={literalId} cols={cols} />

            {cols.status !== 'loading' && (
                <AutoMap
                    t={t} step={step} upstream={upstream} columns={columns} map={map}
                    cellBinding={cellBinding} emit={emit}
                />
            )}

            {fetched && columns.length === 0 && (
                <p className={`${hintTextClass()} italic`}>
                    {t('automations.ndv.tables_row.no_columns', 'This table has no columns yet — add some in Nextcloud first.')}
                </p>
            )}

            <div className="space-y-2">
                {columns.map((col) => (
                    <ColumnRow
                        key={`${col.id ?? ''}|${col.title}`}
                        t={t} col={col} typed={fetched} required={creating && col.mandatory}
                        value={cellBinding(col)} onChange={(b) => setCell(col, b)}
                        {...slotProps}
                    />
                ))}
            </div>

            {!fetched && cols.status !== 'loading' && (
                <ManualTitles t={t} onAdd={(titles) => setManualTitles(prev => [...prev, ...titles.filter(x => !prev.includes(x))])} />
            )}

            {stray.length > 0 && (
                <StrayKeys
                    t={t} keys={stray} map={map} onRemove={removeStray}
                    onChange={(key, b) => emit({ ...map, [key]: b })}
                    {...slotProps}
                />
            )}
        </div>
    );
}

/* ───────────────────────────── pieces ───────────────────────────── */

/** Why the panel is (or is not) asking for titles — one sentence per state. */
function ModeNote({ t, literalId, cols }) {
    if (literalId == null) {
        return (
            <SectionNote>
                {t('automations.ndv.tables_row.table_bound', 'The table is chosen while the automation runs, so its columns cannot be listed here. Type the column titles exactly as they appear in Nextcloud.')}
            </SectionNote>
        );
    }
    if (cols.status === 'loading') {
        return <p className={hintTextClass()}>{t('automations.ndv.tables_row.loading', 'Reading the columns of table {id}…', { id: literalId })}</p>;
    }
    if (cols.status === 'error') {
        return (
            <SectionNote tone="warn">
                <span>
                    {t('automations.ndv.tables_row.load_failed', 'Could not read the columns of table {id} ({error}). Type the column titles exactly as they appear in Nextcloud, or try again.', { id: literalId, error: cols.error || '?' })}
                </span>
                {' '}
                <button type="button" onClick={cols.retry} className={`inline-flex items-center gap-1 ${INLINE_LINK}`}>
                    <RefreshCw size={10} aria-hidden="true" />
                    {t('automations.ndv.tables_row.retry', 'Try again')}
                </button>
            </SectionNote>
        );
    }
    return null;
}

/**
 * "Auto-map": fill the EMPTY columns from one upstream group by normalised
 * name — columnMatch.matchColumns, nothing looser — and say what happened.
 * The source defaults to the group the row is fed by (the step's forEach item,
 * else the nearest step) and can be pointed elsewhere.
 */
function AutoMap({ t, step, upstream, columns, map, cellBinding, emit }) {
    const sources = useMemo(() => mappableGroups(upstream), [upstream]);
    const defaultSource = useMemo(() => feedingGroup(upstream, step), [upstream, step]);
    const [sourceId, setSourceId] = useState(null);
    const source = sources.find(g => g.id === sourceId) || defaultSource;
    const [note, setNote] = useState(null); // { mapped, unmatched } | null

    const run = () => {
        if (!source) return;
        const fields = candidateFields(source);
        const pathByKey = new Map(fields.map(f => [f.key, f.path]));
        const empty = columns.filter(c => isEmptyBinding(cellBinding(c)));
        const { byColumn, unmatchedFields } = matchColumns(fields.map(f => f.key), empty.map(c => c.title));
        const next = { ...map };
        let mapped = 0;
        for (const [title, key] of Object.entries(byColumn)) {
            const path = pathByKey.get(key);
            if (!path) continue;
            next[title] = { kind: 'ref', path };
            mapped += 1;
        }
        if (mapped) emit(next);
        setNote({ mapped, unmatched: unmatchedFields });
    };

    return (
        <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
                {sources.length > 1 && (
                    <label className="flex items-center gap-1 min-w-0">
                        <span className={subLabelClass()}>{t('automations.ndv.tables_row.map_from', 'Map from')}</span>
                        <select
                            className={denseInputClass('max-w-[14rem]')}
                            value={source?.id || ''}
                            onChange={(e) => setSourceId(e.target.value)}
                            aria-label={t('automations.ndv.tables_row.map_from', 'Map from')}
                        >
                            {sources.map(g => <option key={g.id} value={g.id}>{g.label || g.id}</option>)}
                        </select>
                    </label>
                )}
                <button
                    type="button"
                    onClick={run}
                    disabled={!source || !columns.length}
                    className={`${actionButtonClass()} ml-auto disabled:opacity-50`}
                    title={t('automations.ndv.tables_row.automap_title', 'Fill empty columns from {source} — only names that match once spelling differences are ignored', { source: source?.label || '…' })}
                >
                    <Sparkles size={12} aria-hidden="true" /> {t('automations.ndv.tables_row.automap', 'Auto-map')}
                </button>
            </div>
            {note && (
                <p className={hintTextClass()} data-testid="tables-row-automap-note">
                    {t('automations.ndv.tables_row.automap_mapped', '{n} columns filled.', { n: note.mapped })}
                    {note.unmatched.length > 0 && (
                        <>
                            {' '}
                            {t('automations.ndv.tables_row.automap_unmatched', 'No column with that name: {fields}.', { fields: note.unmatched.join(', ') })}
                        </>
                    )}
                </p>
            )}
        </div>
    );
}

function TypeBadge({ t, col }) {
    const [key, en] = TYPE_LABEL[col.type] || TYPE_LABEL_UNKNOWN;
    return (
        <span className={listBadgeClass()} data-testid="tables-row-type" data-type={col.type || 'unknown'}>
            <FieldKindIcon kind={columnKind(col)} size={10} />
            {t(key, en)}
        </span>
    );
}

/** One column: title · Required · type badge · hint, and the value slot. */
function ColumnRow({ t, col, typed, required, value, onChange, onFocusField, previewSample, allowRaw }) {
    const kind = typed ? columnKind(col) : 'unknown';
    const scalar = kind !== 'unknown' && kind !== 'list';
    return (
        <div className={cardClass()} data-testid="tables-row-column">
            <div className="flex items-center gap-1.5 min-w-0">
                <span className={`${fieldLabelClass()} truncate`}>{col.title}</span>
                {required && <span className={requiredChipClass()}>{t('automations.ndv.tables_row.required', 'Required')}</span>}
                {typed && <TypeBadge t={t} col={col} />}
                <FieldHint title={col.title}>{col.description || null}</FieldHint>
            </div>
            <ValueBuilder
                value={value ?? null}
                onChange={onChange}
                label={col.title}
                required={required}
                placeholder={t('automations.ndv.tables_row.leave_empty', 'leave empty to skip {column}', { column: col.title })}
                onFocusField={onFocusField}
                previewSample={previewSample}
                allowRaw={allowRaw}
                expectShape={scalar ? 'scalar' : (kind === 'list' ? 'list' : 'unknown')}
                expectKind={kind}
            />
            {required && <EmptySlotNote expectKind={kind} required empty={isEmptyBinding(value)} />}
        </div>
    );
}

/** The typed-titles fallback: one box, comma-separated, Enter or the button adds. */
function ManualTitles({ t, onAdd }) {
    const [text, setText] = useState('');
    const add = () => {
        const titles = parseTitleList(text);
        if (titles.length) onAdd(titles);
        setText('');
    };
    return (
        <div className="flex items-start gap-1.5">
            <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                placeholder={t('automations.ndv.tables_row.titles_placeholder', 'Column titles, comma-separated — e.g. Bedrijf, Excl. btw')}
                aria-label={t('automations.ndv.tables_row.titles_label', 'Column titles')}
                className={denseInputClass('flex-1 min-w-0')}
            />
            <button type="button" onClick={add} className={actionButtonClass()}>
                {t('automations.ndv.tables_row.add_columns', 'Add columns')}
            </button>
        </div>
    );
}

/** Keys that reach no column of this table: shown by name, editable, removable — never dropped. */
function StrayKeys({ t, keys, map, onRemove, onChange, onFocusField, previewSample, allowRaw }) {
    return (
        <div className="pt-2 border-t border-[var(--border-default)] space-y-2" data-testid="tables-row-stray">
            <div className={subLabelClass()}>
                {t('automations.ndv.tables_row.not_a_column', 'Not a column in this table — the row will fail until these are removed or renamed')}
            </div>
            {keys.map((key) => (
                <div key={key} className={cardClass()}>
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span className={`${fieldLabelClass()} font-mono truncate`}>{key}</span>
                        <button
                            type="button"
                            onClick={() => onRemove(key)}
                            title={t('automations.ndv.tables_row.remove_key', 'Remove {key}', { key })}
                            aria-label={t('automations.ndv.tables_row.remove_key', 'Remove {key}', { key })}
                            className="ml-auto shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-secondary)]"
                        >
                            <Trash2 size={12} />
                        </button>
                    </div>
                    <ValueBuilder
                        value={map[key] ?? null}
                        onChange={(b) => onChange(key, b)}
                        label={key}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        allowRaw={allowRaw}
                    />
                </div>
            ))}
        </div>
    );
}

/**
 * The whole map bound from one place (`{kind:'ref', path:'steps.x.output.row'}`)
 * — there are no columns to draw, so the binding is shown as one slot with a
 * way back to filling the columns one by one.
 */
function WholeRowSlot({ t, value, onChange, onFocusField, previewSample, allowRaw, onSplit }) {
    return (
        <div className="space-y-1.5" data-testid="tables-row-whole">
            <SectionNote>
                {t('automations.ndv.tables_row.whole_bound', 'The whole row comes from one earlier value — it must already be a map of column title to value.')}
            </SectionNote>
            <ValueBuilder
                value={value}
                onChange={onChange}
                label={t('automations.ndv.tables_row.whole_label', 'Row values')}
                showChrome
                expectKind="group"
                onFocusField={onFocusField}
                previewSample={previewSample}
                allowRaw={allowRaw}
            />
            <button type="button" onClick={onSplit} className={`text-[10px] ${INLINE_LINK}`}>
                {t('automations.ndv.tables_row.split', 'Fill in the columns one by one instead')}
            </button>
        </div>
    );
}

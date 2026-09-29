import { AlertTriangle, ArrowLeft, Cloud, Link2, Loader2, Lock, Search } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { ColumnKindIcon } from './ColumnKind';
import { columnTypeKind, keyFromName, ncErrorMessage } from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import { AudienceLine, BTN, CARD, INPUT, INPUT_STYLE, RelationsStep, ReviewRelations, StepStrip, messageFor, relKeyOf, suggestRelations } from './linkWizardShared';
import { TitleRow } from './NewDatatableDialog';
import useTranslation from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * Link one or several Nextcloud tables as datatables — four steps in one
 * dialog (Datatables artboard 1c, second sheet).
 *
 *   1. Which tables?     the linkable list, views as sub-rows, already-linked
 *                        rows disabled
 *   2. Names and columns per table: name, technical name, purpose, and a
 *                        preview of the columns as they will arrive
 *   3. Relations         Nextcloud's own relation columns, locked; same-title
 *                        suggestions, opt-in; and your own "A.x matches B.y"
 *   4. Review            the audience, the list, the relations, then Link
 *
 * A separate dialog from NewDatatableDialog because the 520px form cannot
 * hold a multi-select with views, per-table names, column previews and a
 * relation editor; and a separate file so it has tests of its own.
 *
 * The relations editor is a LIST, not the App Studio ReactFlow map: that map
 * pulls in @xyflow and its stylesheet for two to four tables that need four
 * selects, not a canvas.
 *
 * Relations name their columns by NEXTCLOUD ids (`{ncTableId, ncColumnId}`):
 * the datatable fields do not exist until the link is made, so there is
 * nothing else to name them by yet. The server resolves them.
 *
 * The step strip, the relations editor and the review's relation list are
 * shared with the spreadsheet wizard (linkWizardShared.jsx). That editor
 * knows a column as `{id, title, type}`; the mapping below keeps
 * `ncColumnId` on each column object so the body sent to the server is the
 * integer Nextcloud knows — the wire is unchanged by the extraction.
 */
export default function LinkNextcloudTablesDialog({ scope, linkable, onBack, onClose, onLinked }) {
    const { t } = useTranslation();
    const [step, setStep] = useState('tables');
    const [query, setQuery] = useState('');
    // refKey ('t:4' | 'v:9') → the selection
    const [selection, setSelection] = useState(() => new Map());
    const [describes, setDescribes] = useState(() => new Map());   // refKey → {loading, columns, error}
    const [relations, setRelations] = useState([]);                // manual + suggested (with `enabled`)
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [marks, setMarks] = useState(() => new Map());            // refKey → sentence (server refusals by table)

    const tables = useMemo(() => (linkable && linkable.tables) || [], [linkable]);
    const selected = useMemo(() => [...selection.values()], [selection]);
    const tableSelections = useMemo(() => selected.filter(s => !s.ncViewId), [selected]);

    // ── step 1 helpers ─────────────────────────────────────────────
    const toggle = (row) => {
        const key = row.ncViewId ? `v:${row.ncViewId}` : `t:${row.ncTableId}`;
        setSelection((prev) => {
            const next = new Map(prev);
            if (next.has(key)) { next.delete(key); return next; }
            next.set(key, {
                refKey: key,
                ncTableId: row.ncTableId,
                ncViewId: row.ncViewId || null,
                title: row.title,
                emoji: row.emoji || null,
                name: row.title,
                key: keyFromName(row.title),
                keyTouched: false,
                description: '',
            });
            return next;
        });
    };
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return tables;
        return tables.filter(x => String(x.title || '').toLowerCase().includes(q)
            || (x.views || []).some(v => String(v.title || '').toLowerCase().includes(q)));
    }, [tables, query]);

    // ── step 2: describe lazily, once per selection ────────────────
    useEffect(() => {
        if (step !== 'names') return;
        for (const s of selected) {
            if (describes.has(s.refKey)) continue;
            setDescribes(d => new Map(d).set(s.refKey, { loading: true, columns: [], error: null }));
            datatablesApi.describeNc({ ncTableId: s.ncTableId, ncViewId: s.ncViewId, scope })
                .then(b => setDescribes(d => new Map(d).set(s.refKey, { loading: false, columns: b?.columns || [], error: null })))
                .catch(e => setDescribes(d => new Map(d).set(s.refKey, { loading: false, columns: [], error: ncErrorMessage(t, e) || e.message })));
        }
    }, [step, selected, describes, scope, t]);

    const setSel = (refKey, patch) => setSelection((prev) => {
        const next = new Map(prev);
        next.set(refKey, { ...next.get(refKey), ...patch });
        return next;
    });
    const keyDup = useMemo(() => {
        const seen = new Map();
        for (const s of selected) seen.set(s.key, (seen.get(s.key) || 0) + 1);
        return [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    }, [selected]);
    const namesOk = selected.every(s => s.name.trim() && /^[a-z][a-z0-9_]{0,62}$/.test(s.key)) && keyDup.length === 0;

    // ── step 3: the relations ──────────────────────────────────────
    // Nextcloud's own, when BOTH ends are selected: read from the previews.
    const ncRelations = useMemo(() => {
        const out = [];
        for (const s of tableSelections) {
            const d = describes.get(s.refKey);
            for (const c of (d && d.columns) || []) {
                if (c.type !== 'relation' || !c.relationTarget) continue;
                const target = tableSelections.find(x => x.ncTableId === c.relationTarget.ncTableId);
                out.push({ from: s, column: c, target, resolved: !!target });
            }
        }
        return out;
    }, [tableSelections, describes]);
    // The selected tables as the shared relations editor sees them: each
    // column `{id, title, type}` plus the `ncColumnId` the wire needs.
    const relTables = useMemo(() => tableSelections.map((s) => {
        const d = describes.get(s.refKey);
        return {
            ...s,
            columns: ((d && d.columns) || []).map(c => ({ id: String(c.ncColumnId), title: c.title, type: c.mappedType, ncColumnId: c.ncColumnId })),
        };
    }), [tableSelections, describes]);
    // Nextcloud's own, as the editor lists them: shown, never editable.
    const locked = useMemo(() => ncRelations.map(r => ({
        key: `${r.from.refKey}:${r.column.ncColumnId}`, from: r.from, columnTitle: r.column.title, targetName: r.resolved ? r.target.name : null,
    })), [ncRelations]);
    // Same title in two selected tables — offered, never assumed.
    const suggestions = useMemo(() => suggestRelations(relTables), [relTables]);
    const hasRel = (r) => relations.some(x => relKeyOf(x) === relKeyOf(r));
    const addRelation = (r) => { if (!hasRel(r)) setRelations(list => [...list, r]); };
    const removeRelation = (r) => setRelations(list => list.filter(x => relKeyOf(x) !== relKeyOf(r)));

    // ── submit ─────────────────────────────────────────────────────
    const submit = async () => {
        setBusy(true);
        setError(null);
        setMarks(new Map());
        try {
            const body = await datatablesApi.linkNc({
                scope,
                tables: selected.map(s => ({
                    ...(s.ncViewId ? { ncViewId: s.ncViewId } : { ncTableId: s.ncTableId }),
                    name: s.name.trim(),
                    key: s.key,
                    ...(s.description.trim() ? { description: s.description.trim() } : {}),
                })),
                relations: relations.map(r => ({
                    from: { ncTableId: r.from.ncTableId, ncColumnId: r.localColumn.ncColumnId },
                    to: { ncTableId: r.to.ncTableId, ncColumnId: r.targetColumn.ncColumnId },
                })),
            });
            onLinked(body);
        } catch (e) {
            const msg = ncErrorMessage(t, e) || messageFor(t, e);
            // Point at the row it is about, and go back to the step that can fix it.
            if (e?.code === 'key_taken' && e.body?.key) {
                const hit = selected.find(s => s.key === e.body.key);
                if (hit) { setMarks(new Map([[hit.refKey, msg]])); setStep('names'); }
            } else if ((e?.code === 'already_linked' || e?.code === 'nextcloud_forbidden' || e?.code === 'nc_scope_denied') && e.body?.ncTableId) {
                const hit = selected.find(s => s.ncTableId === e.body.ncTableId);
                if (hit) { setMarks(new Map([[hit.refKey, msg]])); setStep('tables'); }
            }
            setError(msg);
        } finally {
            setBusy(false);
        }
    };

    const STEPS = ['tables', 'names', 'relations', 'review'];
    const at = STEPS.indexOf(step);
    const canNext = step === 'tables' ? selected.length > 0 : step === 'names' ? namesOk : true;
    const next = () => setStep(STEPS[Math.min(STEPS.length - 1, at + 1)]);
    const back = () => (at === 0 ? onBack() : setStep(STEPS[at - 1]));

    return (
        <Modal
            open
            onClose={busy ? () => {} : onClose}
            size="lg"
            title={<TitleRow kind="datatable" icon={Cloud} text={t('datatables.nc_link_title', 'Link tables from Nextcloud')} />}
            headerActions={<StepStrip t={t} at={at} labels={[
                t('datatables.nc_step_tables', 'Tables'),
                t('datatables.nc_step_names', 'Names & columns'),
                t('datatables.nc_step_relations', 'Relations'),
                t('datatables.nc_step_review', 'Review'),
            ]} />}
            footer={(
                <>
                    <button type="button" onClick={back} disabled={busy} className={`${BTN} border inline-flex items-center gap-1.5`}
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('datatables.nc_back', 'Back')}
                    </button>
                    <span className="mr-auto" />
                    <button type="button" onClick={onClose} disabled={busy} className={`${BTN} border`}
                        style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('datatables.cancel', 'Cancel')}
                    </button>
                    {step !== 'review' ? (
                        <button type="button" onClick={next} disabled={!canNext} className={`${BTN} font-medium disabled:opacity-50`}
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {t('datatables.nc_next', 'Next')}
                        </button>
                    ) : (
                        <button type="button" onClick={submit} disabled={busy || !selected.length} className={`${BTN} font-medium disabled:opacity-50 inline-flex items-center gap-1.5`}
                            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}>
                            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                            {selected.length === 1
                                ? t('datatables.nc_link_submit_one', 'Link the table')
                                : t('datatables.nc_link_submit', 'Link {n} tables', { n: selected.length })}
                        </button>
                    )}
                </>
            )}
        >
            <div className="space-y-4">
                {step === 'tables' && (
                    <TablesStep t={t} tables={filtered} query={query} onQuery={setQuery} selection={selection} onToggle={toggle} marks={marks} total={tables.length} />
                )}
                {step === 'names' && (
                    <NamesStep t={t} selected={selected} describes={describes} onChange={setSel} keyDup={keyDup} marks={marks}
                        onSelectTarget={(ncTableId) => { const row = tables.find(x => x.ncTableId === ncTableId); if (row && !selection.has(`t:${ncTableId}`)) toggle(row); }}
                        selectedTableIds={new Set(tableSelections.map(s => s.ncTableId))} />
                )}
                {step === 'relations' && (
                    <RelationsStep t={t} tables={relTables} locked={locked} lockedLabel={t('datatables.nc_relation_from_nc', 'from Nextcloud')}
                        suggestions={suggestions} relations={relations} hasRel={hasRel} onAdd={addRelation} onRemove={removeRelation}
                        intro={t('datatables.nc_relations_intro', 'A relation gives every row of one table a link to one row of another. Nextcloud’s own relation columns are used as they are; you can add your own by matching two columns.')}
                        needTwo={t('datatables.nc_relations_need_two', 'Select at least two tables (not views) to relate them.')} />
                )}
                {step === 'review' && (
                    <ReviewStep t={t} scope={scope} selected={selected} relations={relations} locked={locked.filter(r => r.targetName)} onChangeScope={onBack} />
                )}
                {error && (
                    <p role="alert" className="text-xs px-3 py-2 rounded-lg" style={{ background: 'var(--bg-primary)', color: 'var(--warning)' }}>{error}</p>
                )}
            </div>
        </Modal>
    );
}

function TablesStep({ t, tables, query, onQuery, selection, onToggle, marks, total }) {
    if (!total) {
        return <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('datatables.nc_none', 'Nextcloud has no tables this account can read.')}</p>;
    }
    return (
        <div className="space-y-2">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('datatables.nc_tables_intro', 'Tick the tables to link. A view is a filtered look at a table — it can be linked on its own.')}
            </p>
            {total > 8 && (
                <label className="relative block">
                    <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                    <input value={query} onChange={(e) => onQuery(e.target.value)} placeholder={t('datatables.nc_search_tables', 'Find a table')}
                        aria-label={t('datatables.nc_search_tables', 'Find a table')} className={`${INPUT} pl-9`} style={INPUT_STYLE} />
                </label>
            )}
            <ul className="space-y-1.5" role="list">
                {tables.map((row) => (
                    <li key={row.ncTableId}>
                        <TableRow t={t} row={row} refKey={`t:${row.ncTableId}`} checked={selection.has(`t:${row.ncTableId}`)} onToggle={() => onToggle(row)} mark={marks.get(`t:${row.ncTableId}`)} />
                        {(row.views || []).length > 0 && (
                            <ul className="ml-7 mt-1 space-y-1">
                                {row.views.map(v => (
                                    <li key={v.ncViewId}>
                                        <TableRow t={t} row={{ ...v, ncTableId: row.ncTableId, emoji: null }} refKey={`v:${v.ncViewId}`} isView
                                            checked={selection.has(`v:${v.ncViewId}`)} onToggle={() => onToggle({ ...v, ncTableId: row.ncTableId })} mark={marks.get(`v:${v.ncViewId}`)} />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function TableRow({ t, row, checked, onToggle, mark, isView = false }) {
    const already = Array.isArray(row.linkedAs) && row.linkedAs.length > 0;
    return (
        <label className={`flex items-start gap-3 p-2.5 ${already ? 'cursor-not-allowed' : 'cursor-pointer'}`} style={{ ...CARD, opacity: already ? 0.6 : 1, borderColor: checked ? 'var(--accent-primary)' : 'var(--border-default)' }}>
            <input type="checkbox" checked={checked} disabled={already} onChange={onToggle} className="mt-0.5 shrink-0" aria-label={row.title} />
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 flex-wrap">
                    {row.emoji && <span aria-hidden="true">{row.emoji}</span>}
                    {isView && <span className="text-[11px] px-1.5 rounded" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>{t('datatables.nc_view_word', 'view')}</span>}
                    <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{row.title}</span>
                    {already && (
                        <span className="text-[11px] inline-flex items-center gap-1" style={{ color: 'var(--text-tertiary)' }}>
                            <Link2 className="w-3 h-3" aria-hidden="true" />{t('datatables.nc_already_linked', 'already linked')}
                        </span>
                    )}
                </span>
                {!isView && (
                    <span className="block text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {t('datatables.nc_table_meta', '{rows} rows · {cols} columns', { rows: row.rowsCount ?? '?', cols: row.columnsCount ?? '?' })}
                    </span>
                )}
                {mark && <span className="block text-[11px] mt-1" style={{ color: 'var(--warning)' }}>{mark}</span>}
            </span>
        </label>
    );
}

function NamesStep({ t, selected, describes, onChange, keyDup, marks, onSelectTarget, selectedTableIds }) {
    return (
        <div className="space-y-3">
            {selected.map((s) => {
                const d = describes.get(s.refKey) || { loading: true, columns: [] };
                const dup = keyDup.includes(s.key);
                return (
                    <section key={s.refKey} className="p-3 space-y-2" style={CARD} aria-label={s.title}>
                        <div className="grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)' }}>
                            <label className="block">
                                <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('datatables.field_name', 'Name')}</span>
                                <input value={s.name} onChange={(e) => onChange(s.refKey, { name: e.target.value, ...(s.keyTouched ? {} : { key: keyFromName(e.target.value) }) })}
                                    className={INPUT} style={INPUT_STYLE} aria-label={`${t('datatables.field_name', 'Name')} — ${s.title}`} />
                            </label>
                            <label className="block">
                                <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('datatables.field_key', 'Technical name')}</span>
                                <input value={s.key} onChange={(e) => onChange(s.refKey, { key: e.target.value, keyTouched: true })}
                                    className={`${INPUT} font-mono`} style={{ ...INPUT_STYLE, borderColor: dup ? 'var(--warning)' : INPUT_STYLE.borderColor }}
                                    aria-label={`${t('datatables.field_key', 'Technical name')} — ${s.title}`} />
                            </label>
                        </div>
                        {dup && <p className="text-[11px]" style={{ color: 'var(--warning)' }}>{t('datatables.nc_key_dup', 'Two tables would get the technical name “{key}”.', { key: s.key })}</p>}
                        {marks.get(s.refKey) && <p className="text-[11px]" style={{ color: 'var(--warning)' }}>{marks.get(s.refKey)}</p>}
                        <label className="block">
                            <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('datatables.field_purpose', 'What is it for?')}</span>
                            <textarea value={s.description} onChange={(e) => onChange(s.refKey, { description: e.target.value })} rows={1}
                                className={INPUT} style={INPUT_STYLE} aria-label={`${t('datatables.field_purpose', 'What is it for?')} — ${s.title}`} />
                            <span className="block text-[11px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                                {t('datatables.field_purpose_managed', 'Optional here — left empty, this kind of table brings its own sentence for the processing record.')}
                            </span>
                        </label>
                        <div>
                            <span className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('datatables.nc_columns_preview', 'Columns, as they will arrive')}</span>
                            {d.loading && <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-tertiary)' }}><Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />{t('datatables.nc_reading', 'Reading the columns…')}</span>}
                            {d.error && <p className="text-[11px]" style={{ color: 'var(--warning)' }}>{d.error}</p>}
                            {!d.loading && !d.error && (
                                <ul className="grid gap-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
                                    {d.columns.map((c) => {
                                        const kind = columnTypeKind(c.mappedType);
                                        const missingTarget = c.type === 'relation' && c.relationTarget && c.relationTarget.ncTableId && !selectedTableIds.has(c.relationTarget.ncTableId);
                                        return (
                                            <li key={c.ncColumnId} className="text-xs flex flex-col gap-0.5 px-2 py-1 rounded" style={{ background: 'var(--bg-secondary)' }}>
                                                <span className="inline-flex items-center gap-1.5 min-w-0">
                                                    <ColumnKindIcon kind={kind} size={12} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                                                    <span className="truncate" style={{ color: 'var(--text-primary)' }}>{c.title}</span>
                                                    <span className="ml-auto shrink-0" style={{ color: 'var(--text-tertiary)' }}>{c.type}{c.subtype ? `/${c.subtype}` : ''}</span>
                                                    {c.mandatory && <Lock className="w-3 h-3 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-label={t('datatables.nc_required', 'required in Nextcloud')} />}
                                                </span>
                                                {missingTarget && (
                                                    <span className="inline-flex items-center gap-1 flex-wrap" style={{ color: 'var(--warning)' }}>
                                                        <AlertTriangle className="w-3 h-3 shrink-0" aria-hidden="true" />
                                                        {t('datatables.nc_rel_target_missing', 'Points at a table that is not selected — this column arrives as a plain number.')}
                                                        <button type="button" onClick={() => onSelectTarget(c.relationTarget.ncTableId)} className="underline" style={{ color: 'var(--text-primary)' }}>
                                                            {t('datatables.nc_select_too', 'Select it too')}
                                                        </button>
                                                    </span>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}

function ReviewStep({ t, scope, selected, relations, locked, onChangeScope }) {
    return (
        <div className="space-y-3 text-sm" style={{ color: 'var(--text-primary)' }}>
            <AudienceLine t={t} scope={scope} onChange={onChangeScope} />
            <ul className="space-y-1">
                {selected.map(s => (
                    <li key={s.refKey} className="flex items-center gap-2 p-2.5" style={CARD}>
                        <Cloud className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--type-data)' }} aria-hidden="true" />
                        <span className="truncate">{s.name}</span>
                        <code className="ml-auto text-[11px] font-mono shrink-0" style={{ color: 'var(--text-tertiary)' }}>{s.key}</code>
                    </li>
                ))}
            </ul>
            <ReviewRelations t={t} locked={locked} relations={relations} />
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                {t('datatables.nc_review_note', 'The rows are copied from Nextcloud in the background and kept in step with it. Rows you change here are changed in Nextcloud.')}
            </p>
        </div>
    );
}

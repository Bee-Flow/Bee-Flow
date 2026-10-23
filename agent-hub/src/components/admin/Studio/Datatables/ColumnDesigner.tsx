import { AlertTriangle, GripVertical, Loader2, Lock, Plus, Trash2, Workflow, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import AiTablePanel from './AiTablePanel';
import { ColumnKindIcon, kindWord } from './ColumnKind';
import {
    columnLabel, destructiveChanges, isManagedColumn, isSchemaLocked, keyFromName, sourceErrorMessage, sourceNameOf,
    managedColumnProblem, validateColumns, formColumnHint, isFormAnswers, isRetiredFormColumn,
} from './datatableDisplay';
import { datatablesApi } from './datatablesApi';
import { TypeSelect } from './NewDatatableDialog';
import useTranslation from '../../../../hooks/useTranslation';
import Modal from '../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import Tooltip from '../../../shared/Tooltip';
import useConfirm from '../../../shared/useConfirm';
import { cellText } from '../AppStudio/tables/rowValues';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { FormSource } from './formAnswers';
import type { MirrorSource, SourceError } from './sourceMirrors';
import type { DtColumn, DtTable } from './rowBrowser/rowBrowserModel';
import type { SourceMirror } from './useSourceMirror';
import type { Field, DesignerTable, UsageReader, SaveError, ManagedSaveError, ColumnDesignerProps, UsageSummaryProps, ColumnRowProps, DestructiveConfirmProps } from './ColumnDesigner.types';

export default function ColumnDesigner({ table, canEdit: canEditProp, usage = [], onChanged, mirror = null, onOpenUsage = null }: ColumnDesignerProps) {
    const { t } = useTranslation();
    // A table whose WHOLE column list is the source's — Nextcloud's table,
    // or a spreadsheet's header row: everything is visible, nothing is
    // editable — no add, no move, no remove, no save bar. The owner's
    // `canEdit` is narrowed here rather than upstream so the two "you cannot
    // change this" notices below can say the right reason.
    const schemaLocked = isSchemaLocked(table.managedKind);
    const canEdit = canEditProp && !schemaLocked;
    const sourceName = schemaLocked ? sourceNameOf(table, mirror?.source) : '';
    // A form's answers table: the columns are the form's questions. The one
    // thing the owner may do here is drop the column of a question that is
    // NO LONGER on the form — the only DROP the kind allows.
    const answers = isFormAnswers(table);
    const { confirm, confirmDialog } = useConfirm();
    const [fields, setFields] = useState<Field[] | null>(null);
    const [saved, setSaved] = useState<Field[]>([]);
    const [version, setVersion] = useState<number | null>(null);
    const [sample, setSample] = useState<Record<string, unknown> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState<ReturnType<typeof destructiveChanges> | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const managedKind = table.managedKind || null;

    const load = useCallback(async () => {
        setError(null);
        try {
            // The first row alongside the schema, for the "Example" column —
            // the RowBrowser's own pattern. `allSettled`, because a person
            // who may see the columns and not the rows (or a table that is
            // simply empty) must still get the designer: a sample is a nicety,
            // the column list is the point.
            const [schemaOut, rowsOut] = await Promise.allSettled([
                datatablesApi.getSchema(table.id),
                datatablesApi.listRows(table.id, { limit: 1 }),
            ]);
            if (schemaOut.status === 'rejected') throw schemaOut.reason;
            const schema = schemaOut.value;
            setFields(schema.fields || []);
            setSaved(schema.fields || []);
            setVersion(schema.modelVersion ?? null);
            setSample(rowsOut.status === 'fulfilled' ? (rowsOut.value?.rows?.[0] || null) : null);
        } catch (e) {
            setError((e as Error).message || t('datatables.err_columns_load', 'Could not load the columns'));
            setFields([]);
        }
    }, [table.id, t]);

    useEffect(() => { load(); }, [load]);

    const set = (i: number, patch: Partial<Field>) => setFields(fs => (fs as Field[]).map((f, j) => (j === i ? { ...f, ...patch } : f)));
    const add = () => setFields(fs => [...(fs as Field[]), { key: '', name: '', type: 'text' }]);
    const remove = (i: number) => setFields(fs => (fs as Field[]).filter((_, j) => j !== i));
    const move = (i: number, delta: number) => setFields((fs) => {
        const j = i + delta;
        if (j < 0 || j >= (fs as Field[]).length) return fs;
        const next = [...(fs as Field[])];
        [next[i], next[j]] = [next[j], next[i]];
        return next;
    });
    // A dragged row lands BEFORE the row it is dropped on (after it when
    // dragged downwards), the way a list reads.
    const moveTo = (from: number, to: number) => setFields((fs) => {
        if (from === to || from < 0 || to < 0 || from >= (fs as Field[]).length || to >= (fs as Field[]).length) return fs;
        const next = [...(fs as Field[])];
        const [row] = next.splice(from, 1);
        next.splice(to, 0, row);
        return next;
    });
    const dragFrom = useRef<number | null>(null);

    const problems = validateColumns(fields || []);
    // The managed contract is checked BEFORE the destructive-change dialog:
    // "this deletes 40,000 values, are you sure" is the wrong question about a
    // column the server is going to refuse either way.
    const managedProblem = managedColumnProblem(managedKind, fields || []);
    const dirty = JSON.stringify(fields) !== JSON.stringify(saved);

    // `confirmBreaking` is only ever true on the path that came through
    // DestructiveConfirm, which lists the automations that read the column
    // being dropped. The server refuses the drop without it.
    const doSave = useCallback(async (confirmBreaking: boolean = false) => {
        setBusy(true);
        setError(null);
        setNote(null);
        try {
            const body = await datatablesApi.putSchema(table.id, fields as Field[], version, { confirmBreaking });
            setSaved(body.fields || (fields as Field[]));
            setVersion(body.modelVersion ?? null);
            setConfirming(null);
            setNote(t('datatables.columns_saved', 'Columns saved.'));
            onChanged?.();
        } catch (e) {
            const refused = sourceErrorMessage(t, e as SourceError, table);
            if (refused) { setError(refused); return; }
            if ((e as SaveError).managed) {
                // A Solution stage manages this table (409 managed_part): not a
                // column conflict, so do not reload and call it someone else's edit.
                setError((e as Error).message || (e as ManagedSaveError).managed.message);
                setConfirming(null);
            } else if ((e as SaveError).status === 409 && (e as SaveError).code === 'managed_column') {
                // Belt and braces: the guard above should have caught it, but
                // the contract lives on the server and this client may be an
                // old tab. Show the server's own sentence, which names the
                // column.
                setError((e as Error).message);
                setConfirming(null);
            } else if ((e as SaveError).status === 409 && (e as SaveError).code === 'breaking_change') {
                // The server saw a dependent this screen's own diff did not —
                // the usage index moved since it was loaded. Show the real list
                // and let the person confirm against THAT, rather than
                // reporting a conflict that did not happen.
                setError(t('datatables.err_breaking', 'An automation still uses a column you are removing. Check "used by" and confirm the change.'));
                setConfirming(null);
                await load();
            } else if ((e as SaveError).status === 409) {
                // Never silently clobber. Reload so what is on screen is what
                // the other person left, and say what happened to the edit.
                setError(t('datatables.err_conflict', 'Someone else changed these columns while you were editing. Their version is now shown — please make your change again.'));
                setConfirming(null);
                await load();
            } else {
                setError((e as Error).message || t('datatables.err_columns_save', 'Could not save the columns'));
            }
        } finally {
            setBusy(false);
        }
    }, [table, fields, version, onChanged, load, t]);

    const attemptSave = () => {
        const changes = destructiveChanges(saved, fields);
        if (changes.any) setConfirming(changes);
        else doSave();
    };

    if (fields === null) {
        return (
            <div className="py-8 flex justify-center text-[var(--text-tertiary)]">
                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                <span className="sr-only">{t('datatables.loading', 'Loading…')}</span>
            </div>
        );
    }

    return (
        <div className="space-y-3.5">
            {confirmDialog}
            {answers ? (
                <p className="text-xs flex items-start gap-2"
                    style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                    <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{t('datatables.frm_columns_locked', 'These columns are the questions on the form. Add, rename or remove questions on the form — the table follows. A column whose question was removed stays here, marked “no longer on the form”, and can be removed from this tab.')}</span>
                </p>
            ) : schemaLocked ? (
                <p className="text-xs flex items-start gap-2"
                    style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                    <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{t('datatables.src_columns_locked', 'These columns come from {source} and cannot be added to, removed, renamed or retyped here. Change them in {source} — the next refresh brings them here.', { source: sourceName })}</span>
                </p>
            ) : !canEdit && (
                <p className="text-xs px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                    {/* Two different reasons land here — not the owner, or no
                        manage permission — and neither is the person's mistake,
                        so the sentence names the fix rather than the refusal. */}
                    {t('datatables.columns_readonly', 'You can see the columns but not change them. The table’s owner, or an administrator, can.')}
                </p>
            )}

            {managedKind && canEdit && (
                <p className="text-xs flex items-start gap-2"
                    style={{ padding: '8px 12px', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                    <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{t('datatables.columns_managed', 'The locked columns are filled in automatically and cannot be removed, renamed or retyped. Columns of your own can be added alongside them.')}</span>
                </p>
            )}

            {/* "Build it with AI" — only on a table whose columns are the
                person's own: a cache, a mirror or a form's answers has a
                contract of its own and gets no box. The draft lands in the
                unsaved list above the Save bar; the guard against removing
                and retyping is explained on the card. */}
            {canEdit && !schemaLocked && !managedKind && fields && (
                <AiTablePanel
                    mode="revise"
                    current={{ name: table.name, description: table.description, rowCount: table.rowCount, managedKind: table.managedKind || null, fields }}
                    onApply={(d) => {
                        const byKey = new Map<string, Field>((saved || []).map(f => [f.key, f]));
                        setFields(((Array.isArray(d.fields) ? d.fields : []) as Field[]).map(f => {
                            const prev = byKey.get(f.key);
                            return {
                                ...(prev?.id ? { id: prev.id } : {}),
                                key: f.key, name: f.name, type: f.type,
                                ...(f.options ? { options: f.options } : {}),
                                ...(f.required ? { required: true } : {}),
                                ...(f.unique ? { unique: true } : {}),
                            };
                        }));
                    }}
                    testId="columns-ai"
                />
            )}

            {fields.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">
                    {t('datatables.columns_empty', 'No columns yet. Every table already has id, created_at, updated_at and created_by — add the ones your automation needs on top.')}
                </p>
            ) : (
                <div className="overflow-hidden" style={CARD_STYLE}>
                    <div className="grid items-center" style={{ ...GRID, ...HEAD_STYLE }} role="presentation">
                        <span />
                        <span>{t('datatables.col_head_column', 'Column')}</span>
                        <span>{t('datatables.col_head_kind', 'Kind')}</span>
                        <span>{t('datatables.col_head_example', 'Example')}</span>
                        <span />
                    </div>
                    <ul>
                        {fields.map((f, i) => (
                            <ColumnRow
                                key={i}
                                t={t}
                                field={f}
                                canEdit={canEdit}
                                managedKind={managedKind}
                                locked={isManagedColumn(managedKind, f.key)}
                                ncColumn={answers ? (formColumnHint(t, table.source as FormSource | null | undefined, f) || managedHint(t, 'form_answers', f.key)) : (mirror?.source?.relations || schemaLocked ? sourceColumnInfo(t, f, mirror, sourceName) : null)}
                                onRemoveRetired={answers && canEditProp && isRetiredFormColumn(table.source as FormSource | null | undefined, f) ? async () => {
                                    const ok = await confirm({
                                        title: t('datatables.frm_remove_retired_title', 'Remove the column “{name}”?', { name: columnLabel(f) }),
                                        description: t('datatables.frm_remove_retired_body', 'Its answers in {n} rows are deleted for good. The form is not affected — the question is already gone from it.', { n: table.rowCount ?? 0 }),
                                        confirmLabel: t('datatables.frm_remove_retired_confirm', 'Remove the column'),
                                        cancelLabel: t('datatables.cancel', 'Cancel'),
                                        destructive: true,
                                    });
                                    if (!ok) return;
                                    try {
                                        await datatablesApi.removeAnswersColumn(table.id, f.id as string, { confirmBreaking: true });
                                        await load();
                                        if (onChanged) onChanged();
                                    } catch (e) {
                                        setError((e as Error)?.message || t('datatables.frm_err_remove', 'Could not remove the column.'));
                                    }
                                } : null}
                                first={i === 0}
                                last={i === fields.length - 1}
                                sample={sample}
                                readers={usage.filter(u => (u.columns || []).includes(f.key))}
                                onOpenUsage={onOpenUsage}
                                onChange={(patch: Partial<Field>) => set(i, patch)}
                                onMove={(delta) => move(i, delta)}
                                onRemove={() => remove(i)}
                                drag={canEdit && !schemaLocked ? {
                                    start: () => { dragFrom.current = i; },
                                    over: (e: React.DragEvent) => { if (dragFrom.current !== null) e.preventDefault(); },
                                    drop: (e: React.DragEvent) => { e.preventDefault(); if (dragFrom.current !== null) moveTo(dragFrom.current, i); dragFrom.current = null; },
                                    end: () => { dragFrom.current = null; },
                                } : null}
                            />
                        ))}
                    </ul>
                </div>
            )}

            {canEdit && (
                <button type="button" onClick={add}
                    className="text-xs inline-flex items-center gap-1.5 rounded px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.column_add', 'Add a column')}
                </button>
            )}
            {canEdit && fields.length > 1 && (
                <p className="text-xs m-0" style={{ color: 'var(--text-tertiary)', lineHeight: '18px' }} data-testid="columns-hint">
                    {t('datatables.columns_hint', 'Drag the handle to reorder. Columns an automation writes to are marked; removing one breaks that step until you fix it there.')}
                </p>
            )}

            {/* aria-live, because every one of these appears WITHOUT the focus
                moving — a screen-reader user pressing Save otherwise hears
                nothing at all, whether it worked or not. */}
            <div aria-live="polite" className="space-y-2">
                {problems.length > 0 && (
                    <ul className="text-xs space-y-1 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--warning)]">
                        {problems.map((p, i) => <li key={i}>{p}</li>)}
                    </ul>
                )}
                {managedProblem && (
                    <p className="text-xs px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--warning)]">
                        {managedProblemText(t, managedProblem)}
                    </p>
                )}
                {error && (
                    <p className="text-xs px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--warning)]">
                        {error}
                    </p>
                )}
                {note && <p className="text-xs text-[var(--text-secondary)]">{note}</p>}
            </div>

            {canEdit && dirty && (
                <div className="sticky bottom-0 flex items-center gap-2 py-3 -mx-1 px-1"
                    style={{ background: 'var(--bg-primary)', borderTop: '1px solid var(--border-default)' }}>
                    <span className="text-xs mr-auto text-[var(--text-tertiary)]">
                        {t('datatables.columns_unsaved', 'Unsaved column changes')}
                    </span>
                    <button type="button" onClick={() => setFields(saved)} className={`${BTN} border`}
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('datatables.discard', 'Discard')}
                    </button>
                    <button
                        type="button"
                        onClick={attemptSave}
                        disabled={busy || problems.length > 0 || !!managedProblem}
                        className={`${BTN} font-medium disabled:opacity-50 inline-flex items-center gap-1.5`}
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    >
                        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                        {t('datatables.columns_save', 'Save columns')}
                    </button>
                </div>
            )}

            <DestructiveConfirm
                t={t}
                changes={confirming}
                rowCount={table.rowCount ?? 0}
                usage={usage}
                busy={busy}
                onCancel={() => setConfirming(null)}
                onConfirm={() => doSave(true)}
            />
        </div>
    );
}

const BTN = 'px-3 py-1.5 rounded-[10px] text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2';
const ICON_BTN = 'p-0.5 rounded shrink-0 disabled:opacity-30 focus-visible:outline focus-visible:outline-2';

const CARD_STYLE = {
    borderRadius: 12,
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    boxShadow: 'var(--shadow-sm)',
};

// Ronde 2's 24|1fr|190|260|32: the grip alone, the name with its pill, the
// kind, a wider example (chips need it), the remove.
const GRID = { display: 'grid', gridTemplateColumns: '24px minmax(0,1fr) 190px 260px 32px', gap: 12 };

const HEAD_STYLE = {
    padding: '8px 14px',
    borderBottom: '1px solid var(--border-default)',
    fontSize: 10,
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    fontWeight: 600,
    color: 'var(--text-tertiary)',
};

/** One refusal from the managed contract, as a sentence in the reader's language. */
function managedProblemText(t: TranslateFn, problem: { reason: string; key?: string; type?: string }) {
    switch (problem.reason) {
        case 'retyped':
            return t('datatables.managed_retyped', '“{key}” is filled in automatically and has to stay a {type} column.', problem);
        case 'unique':
            return t('datatables.managed_unique', '“{key}” has to stay unique — without it every refresh would add a second row instead of replacing the first.', problem);
        case 'required':
            return t('datatables.managed_required', '“{key}” has to stay required — it is filled in automatically.', problem);
        case 'definition_owned':
            return t('datatables.managed_definition_owned', 'The columns of this table come from the form.');
        default:
            return t('datatables.managed_missing', '“{key}” is part of how this table is filled in automatically. It cannot be removed or renamed.', problem);
    }
}

/**
 * What a platform-owned column is FOR, in prose (artboard 1d).
 *
 * Named per column rather than a blanket "filled in automatically", because
 * the two that matter are not obvious: `cache_key` is what a later run looks
 * the answer up by, and `fetched_at` is where the retention window counts
 * from — delete the wrong thing and either the cache never hits again or the
 * rows never expire.
 */
/**
 * What a MIRROR column is, for its hint: where it came from (the source),
 * which relation fills it in, or — on a spreadsheet — that it is the key
 * column a row is recognised by. `mirror.source` carries the relations and
 * the key column; the source's own type per column is not shipped to the
 * client, so the hint names the source and the role, not the type.
 */
function sourceColumnInfo(t: TranslateFn, field: Field, mirror: SourceMirror | null | undefined, sourceName: string) {
    const source = (mirror && mirror.source) || null;
    const relations = (source && source.relations) || [];
    const rel = relations.find((r) => r.fieldId === field.id);
    if (rel && rel.kind === 'nc') return t('datatables.nc_column_relation_nc', 'from Nextcloud · a link to a row of another linked table');
    if (rel && rel.kind === 'match') return t('datatables.nc_column_relation_declared', 'filled in here · matched on a column of another linked table');
    const label = relations.find((r) => r.kind === 'nc' && r.labelFieldId === field.id);
    if (label) return t('datatables.nc_column_label', 'filled in here · the name of the linked row');
    if (source && source.keyColumn && source.keyColumn.fieldId === field.id) {
        return t('datatables.ss_column_key', 'from {source} · the key column that identifies a row', { source: sourceName });
    }
    return t('datatables.src_column_hint', 'from {source}', { source: sourceName });
}

function managedHint(t: TranslateFn, kind: string | null, key: string) {
    if (kind === 'form_answers') {
        if (key === 'run_id') return t('datatables.frm_hint_run_id', 'fixed · the run the submission started');
        if (key === 'completed_at') return t('datatables.frm_hint_completed_at', 'fixed · when the last page was answered');
        return null;
    }
    if (kind !== 'http_cache') return null;
    switch (key) {
        case 'cache_key': return t('datatables.managed_hint.cache_key', 'fixed · what a later run finds the answer back by');
        case 'response_status': return t('datatables.managed_hint.response_status', 'fixed · the answer code the service gave');
        case 'response_body': return t('datatables.managed_hint.response_body', 'fixed · what the service sent back');
        case 'fetched_at': return t('datatables.managed_hint.fetched_at', 'fixed · the retention window counts from here');
        case 'request_host': return t('datatables.managed_hint.request_host', 'fixed · which service was asked');
        case 'request_path': return t('datatables.managed_hint.request_path', 'fixed · what was asked for');
        case 'request_method': return t('datatables.managed_hint.request_method', 'fixed · how it was asked');
        case 'response_headers': return t('datatables.managed_hint.response_headers', 'fixed · what the service said about its answer');
        default: return t('datatables.managed_hint.other', 'fixed · filled in automatically');
    }
}

const SUMMARY_MAX = 5;

function UsageSummary({ t, readers }: UsageSummaryProps) {
    const roleWord = (mode: string | undefined) => mode === 'readwrite' ? t('usage.role_readwrite', 'reads and writes')
        : mode === 'write' ? t('usage.role_write', 'writes') : t('usage.role_read', 'reads');
    return (
        <span className="flex flex-col gap-0.5 text-left">
            {readers.slice(0, SUMMARY_MAX).map((u, i) => (
                <span key={`${u.consumerId || u.automationId || ''}:${u.stepOrdinal || i}`}>
                    {u.consumerTitle || u.automationTitle || t('datatables.column_usage_unnamed', 'An automation')}
                    {u.stepOrdinal ? ` · ${t('datatables.column_usage_step', 'step {n}', { n: u.stepOrdinal })}` : ''}
                    {` · ${roleWord(u.mode)}`}
                </span>
            ))}
            {readers.length > SUMMARY_MAX && (
                <span>{t('datatables.column_usage_more', '+ {n} more', { n: readers.length - SUMMARY_MAX })}</span>
            )}
            <span className="font-normal opacity-75">{t('datatables.column_usage_open', 'Click to open Used by')}</span>
        </span>
    );
}

function ColumnRow({
    t, field, canEdit, managedKind, locked, first, last, sample, readers,
    onChange, onMove, onRemove, ncColumn = null, onRemoveRetired = null, drag = null, onOpenUsage = null,
}: ColumnRowProps) {
    const needsOptions = field.type === 'select' || field.type === 'multiselect';
    const label = columnLabel(field) || t('datatables.column_generic', 'column');
    // A locked column is still visible, still sortable and still shows who
    // reads it — only its identity is fixed.
    const editable = canEdit && !locked;
    // Only a column that is NOT the person's own carries a hint: where it
    // comes from, or that it is fixed. An own column's row is its name.
    const hint = ncColumn ? ncColumn : locked ? managedHint(t, managedKind, field.key) : null;
    // `cellText` answers an em dash for an absent value; "still empty" is the
    // same fact in words, and the dash would read as a value of its own here.
    const shown = sample ? cellText(sample[field.key], field) : null;
    const example = shown && shown !== '—' ? shown : null;
    const [optionsOpen, setOptionsOpen] = useState(false);
    const options = Array.isArray(field.options) ? field.options : [];
    const writers = readers.filter(u => u.mode === 'write' || u.mode === 'readwrite');
    const marked = writers.length ? writers : readers;

    const onHandleKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
        if (e.key === 'ArrowUp' && !first) { e.preventDefault(); onMove(-1); }
        else if (e.key === 'ArrowDown' && !last) { e.preventDefault(); onMove(1); }
    };

    return (
        <li style={{ borderBottom: last ? 'none' : '1px solid var(--border-default)' }}
            onDragOver={drag ? drag.over : undefined} onDrop={drag ? drag.drop : undefined}>
            <div className="grid items-center" style={{ ...GRID, padding: '9px 14px' }}>
                {drag ? (
                    <button
                        type="button"
                        draggable
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', label); } catch { /* jsdom */ } drag.start(); }}
                        onDragEnd={drag.end}
                        onKeyDown={onHandleKey}
                        className="grid place-items-center w-6 h-6 rounded cursor-grab active:cursor-grabbing focus-visible:outline focus-visible:outline-2"
                        style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}
                        aria-label={t('datatables.column_reorder', 'Reorder {name} — drag, or use the arrow keys', { name: label })}
                        title={t('datatables.column_reorder_hint', 'Drag to reorder · ↑ ↓')}
                        data-testid="column-grip"
                    >
                        <GripVertical className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                ) : (
                    <GripVertical className="w-3.5 h-3.5 justify-self-center" aria-hidden="true"
                        style={{ color: 'var(--text-tertiary)', opacity: 0.25 }} />
                )}

                <span className="min-w-0 flex items-center gap-2">
                    <input
                        value={field.name || ''}
                        disabled={!editable}
                        aria-label={t('datatables.column_name', 'Column name')}
                        onChange={(e) => {
                            // Derive the key from the name only while it is still
                            // empty: once a column exists its key is what the rows
                            // are stored under, and rewriting it from a rename
                            // would silently drop the column and add a new one.
                            const name = e.target.value;
                            onChange(field.key ? { name } : { name, key: keyFromName(name) });
                        }}
                        placeholder={t('datatables.column_name', 'Column name')}
                        className="min-w-0 flex-1 bg-transparent text-sm font-medium rounded px-1 -mx-1 border border-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 disabled:opacity-100"
                        style={{ color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}
                    />
                    {marked.length > 0 && (
                        <Tooltip content={<UsageSummary t={t} readers={readers} />}>
                            <button type="button" onClick={onOpenUsage || undefined}
                                className="inline-flex items-center gap-1 text-[11px] shrink-0 whitespace-nowrap px-[7px] py-px rounded-full cursor-pointer bg-[var(--bg-secondary)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:border-[var(--accent-primary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 outline-[var(--accent-primary)]"
                                aria-label={writers.length ? t('datatables.column_written_by', 'An automation writes to this column') : t('datatables.column_read_by', 'An automation reads this column')}
                                data-testid="column-usage">
                                <Workflow className="w-[11px] h-[11px]" aria-hidden="true" />
                                {marked.length === 1
                                    ? t('datatables.column_used_one_pill', '1 automation')
                                    : t('datatables.column_used_many_pill', '{n} automations', { n: marked.length })}
                            </button>
                        </Tooltip>
                    )}
                </span>

                {field.type === 'relation' ? (
                    <span className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs border" style={{ borderColor: 'var(--border-default)', color: 'var(--text-primary)', opacity: 0.6 }}>
                        <ColumnKindIcon kind="relation" size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                        <span className="truncate">{kindWord(t, 'relation')}</span>
                    </span>
                ) : (
                    <TypeSelect
                        t={t}
                        value={field.type}
                        disabled={!editable}
                        onChange={(type) => onChange({ type })}
                        ariaLabel={t('datatables.column_type', 'Column type')}
                    />
                )}

                {needsOptions ? (
                    <span className="flex items-center gap-1 min-w-0 overflow-hidden" data-testid="column-options">
                        {options.slice(0, 6).map(o => (
                            <span key={o} className="text-[11px] whitespace-nowrap shrink-0"
                                style={{ padding: '2px 7px', borderRadius: 999, background: 'var(--bg-secondary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}>
                                {o}
                            </span>
                        ))}
                        {options.length > 6 && <span className="text-[11px] shrink-0 text-[var(--text-tertiary)]">+{options.length - 6}</span>}
                        {editable && (
                            <button type="button" onClick={() => setOptionsOpen(o => !o)} aria-expanded={optionsOpen}
                                className="grid place-items-center shrink-0 rounded-full focus-visible:outline focus-visible:outline-2"
                                style={{ width: 22, height: 22, border: '1px dashed var(--border-default)', color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}
                                aria-label={t('datatables.column_options_edit', 'Edit the choices of {name}', { name: label })}
                                data-testid="column-options-edit">
                                {optionsOpen ? <X className="w-[11px] h-[11px]" aria-hidden="true" /> : <Plus className="w-[11px] h-[11px]" aria-hidden="true" />}
                            </button>
                        )}
                        {!options.length && !editable && <span className="text-xs text-[var(--text-tertiary)]">{t('datatables.column_no_example', 'still empty')}</span>}
                    </span>
                ) : (
                    <span className="text-xs truncate tabular-nums" style={{ color: example ? 'var(--text-secondary)' : 'var(--text-tertiary)' }}
                        title={example || undefined}>
                        {example || t('datatables.column_no_example', 'still empty')}
                    </span>
                )}

                <span className="justify-self-end">
                    {onRemoveRetired ? (
                        <button type="button" onClick={onRemoveRetired} className="p-1 rounded focus-visible:outline focus-visible:outline-2"
                            aria-label={t('datatables.frm_remove_retired', 'Remove {name}', { name: label })}
                            title={t('datatables.frm_remove_retired', 'Remove {name}', { name: label })}
                            style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }} data-testid="remove-retired">
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    ) : (canEdit || ncColumn) && (locked ? (
                        <span className="p-1 inline-flex" title={t('datatables.column_locked', 'Filled in automatically — this column cannot be removed, renamed or retyped.')}>
                            <Lock className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
                            <span className="sr-only">{t('datatables.column_locked', 'Filled in automatically — this column cannot be removed, renamed or retyped.')}</span>
                        </span>
                    ) : (
                        <button type="button" onClick={onRemove} className="p-1 rounded focus-visible:outline focus-visible:outline-2"
                            aria-label={t('datatables.column_remove_named', 'Remove {name}', { name: label })}
                            style={{ color: 'var(--text-tertiary)', outlineColor: 'var(--accent-primary)' }}>
                            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    ))}
                </span>
            </div>

            {hint && (
                <div className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)', padding: '0 14px 8px 50px', marginTop: -4 }}>
                    {hint}
                </div>
            )}

            {needsOptions && (optionsOpen || (editable && options.length === 0)) && (
                <div className="pb-2.5 -mt-1" style={{ padding: '0 14px 10px 50px' }}>
                    <input
                        value={(field.options || []).join(', ')}
                        disabled={!editable}
                        aria-label={t('datatables.column_options', 'Options for {name}', { name: label })}
                        onChange={(e) => onChange({ options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                        placeholder={t('datatables.column_options_ph', 'Option one, Option two, Option three')}
                        className="w-full px-2 py-1 rounded text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                        style={{
                            background: 'var(--bg-primary)', borderColor: 'var(--border-default)',
                            color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
                        }}
                    />
                </div>
            )}
        </li>
    );
}

function DestructiveConfirm({ t, changes, rowCount, usage, busy, onCancel, onConfirm }: DestructiveConfirmProps) {
    if (!changes) return null;
    const touched = new Set<string | null | undefined>([...changes.removed, ...changes.retyped.map(r => r.key)]);
    const affected = usage.filter(u => (u.columns || []).some(c => touched.has(c)));
    return (
        <Modal
            open
            onClose={onCancel}
            // A destructive confirmation must not be dismissible by a stray
            // click on the backdrop; ESC still works, because ESC is a
            // deliberate cancel.
            disableBackdropClose
            size="md"
            title={
                <span className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--error)' }} aria-hidden="true" />
                    {t('datatables.destructive_title', 'This throws away data')}
                </span>
            }
        >
            <div className="space-y-3">
                {changes.removed.length > 0 && (
                    <p className="text-sm text-[var(--text-secondary)]">
                        {rowCount === 1
                            ? t('datatables.destructive_removed_one', 'Removing {keys} deletes its value in the 1 row.', { keys: changes.removed.join(', ') })
                            : t('datatables.destructive_removed', 'Removing {keys} deletes its values in all {n} rows.', { keys: changes.removed.join(', '), n: rowCount })}
                    </p>
                )}
                {changes.retyped.length > 0 && (
                    <p className="text-sm text-[var(--text-secondary)]">
                        {t('datatables.destructive_retyped', 'Changing the type of {keys} rewrites every existing value, and anything that does not fit the new type is lost.', { keys: changes.retyped.map(r => r.key).join(', ') })}
                    </p>
                )}
                {affected.length > 0 && (
                    <p className="text-xs px-3 py-2 rounded bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                        {affected.length === 1
                            ? t('datatables.destructive_readers_one', '1 automation reads one of these columns and will stop working: {names}.', { names: nameList(affected) })
                            : t('datatables.destructive_readers', '{n} automations read one of these columns and will stop working: {names}.', { n: affected.length, names: nameList(affected) })}
                    </p>
                )}
                <div className="flex justify-end gap-2 pt-1">
                    <button type="button" onClick={onCancel} className={`${BTN} border`}
                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)', outlineColor: 'var(--accent-primary)' }}>
                        {t('datatables.destructive_keep', 'Keep them')}
                    </button>
                    <button type="button" onClick={onConfirm} disabled={busy}
                        className={`${BTN} font-medium text-white disabled:opacity-50 inline-flex items-center gap-1.5`}
                        style={{ background: 'var(--error)', outlineColor: 'var(--error)' }}>
                        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                        {t('datatables.destructive_confirm', 'Save anyway')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

/** The first three consumer names, and how many more there are. */
function nameList(list: UsageReader[]) {
    const names = list.slice(0, 3).map(u => u.consumerTitle || u.automationTitle || u.automationId).join(', ');
    return list.length > 3 ? `${names} +${list.length - 3}` : names;
}

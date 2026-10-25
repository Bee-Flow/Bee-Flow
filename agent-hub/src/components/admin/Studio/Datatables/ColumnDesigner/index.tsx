import { Loader2, Lock, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import AiTablePanel from '../AiTablePanel';
import { columnLabel, destructiveChanges, isManagedColumn, isSchemaLocked, sourceErrorMessage, sourceNameOf, managedColumnProblem, validateColumns, formColumnHint, isFormAnswers, isRetiredFormColumn } from '../datatableDisplay';
import { datatablesApi } from '../datatablesApi';
import useTranslation, { TranslateParams } from '../../../../../hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import useConfirm from '../../../../shared/useConfirm';
import type { FormSource } from '../formAnswers';
import type { MirrorSource, SourceError } from '../sourceMirrors';
import type { DtColumn, DtTable } from '../rowBrowser/rowBrowserModel';
import type { Field, DesignerTable, SaveError, ManagedSaveError, ColumnDesignerProps } from '../ColumnDesigner.types';
import { managedProblemText, sourceColumnInfo, managedHint } from './ColumnDesigner.helpers';
import { GRID, ColumnRow } from './ColumnRow';
import { BTN, DestructiveConfirm } from './DestructiveConfirm';

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
                <p className="text-xs flex items-start gap-2 [padding:8px_12px] [border-radius:8px] [background:var(--bg-secondary)] [color:var(--text-secondary)]!">
                    <Lock className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{t('datatables.frm_columns_locked', 'These columns are the questions on the form. Add, rename or remove questions on the form — the table follows. A column whose question was removed stays here, marked “no longer on the form”, and can be removed from this tab.')}</span>
                </p>
            ) : schemaLocked ? (
                <p className="text-xs flex items-start gap-2 [padding:8px_12px] [border-radius:8px] [background:var(--bg-secondary)] [color:var(--text-secondary)]!">
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
                <p className="text-xs flex items-start gap-2 [padding:8px_12px] [border-radius:8px] [background:var(--bg-secondary)] [color:var(--text-secondary)]!">
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
                    className="text-xs inline-flex items-center gap-1.5 rounded px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!">
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.column_add', 'Add a column')}
                </button>
            )}
            {canEdit && fields.length > 1 && (
                <p className="text-xs m-0 [color:var(--text-tertiary)]! [line-height:18px]" data-testid="columns-hint">
                    {t('datatables.columns_hint', 'Drag the handle to reorder. Columns an automation writes to are marked; removing one breaks that step until you fix it there.')}
                </p>
            )}

            {/* aria-live, because every one of these appears WITHOUT the focus
                moving — a screen-reader user pressing Save otherwise hears
                nothing at all, whether it worked or not. */}
            <ColumnDesignerSection problems={problems} managedProblem={managedProblem} t={t} error={error} note={note} />

            {canEdit && dirty && (
                <div className="sticky bottom-0 flex items-center gap-2 py-3 -mx-1 px-1 [background:var(--bg-primary)] [border-top:1px_solid_var(--border-default)]">
                    <span className="text-xs mr-auto text-[var(--text-tertiary)]">
                        {t('datatables.columns_unsaved', 'Unsaved column changes')}
                    </span>
                    <button type="button" onClick={() => setFields(saved)} className={`${BTN} border [border-color:var(--border-default)] [color:var(--text-secondary)] [outline-color:var(--accent-primary)]`}>
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

const ICON_BTN = 'p-0.5 rounded shrink-0 disabled:opacity-30 focus-visible:outline focus-visible:outline-2';

const CARD_STYLE = {
    borderRadius: 12,
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    boxShadow: 'var(--shadow-sm)',
};

const HEAD_STYLE = {
    padding: '8px 14px',
    borderBottom: '1px solid var(--border-default)',
    fontSize: 10,
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    fontWeight: 600,
    color: 'var(--text-tertiary)',
};


function ColumnDesignerSection({ problems, managedProblem, t, error, note }: { problems: string[]; managedProblem: { reason: string; key?: undefined; type?: undefined; } | { reason: string; key: string; type?: undefined; } | { reason: string; key: string; type: string; } | null; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; error: string | null; note: string | null; }) {
    return <div aria-live="polite" className="space-y-2">
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
    </div>;
}

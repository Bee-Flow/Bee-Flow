import React, { useCallback, useEffect, useRef, useState } from 'react';
import AiTablePanel from '../AiTablePanel';
import { columnLabel, destructiveChanges, isManagedColumn, isSchemaLocked, sourceErrorMessage, sourceNameOf, managedColumnProblem, validateColumns, formColumnHint, isFormAnswers, isRetiredFormColumn } from '../datatableDisplay';
import { datatablesApi } from '../datatablesApi';
import useTranslation, { TranslateParams, type TranslateFn } from '@/hooks/useTranslation';
import useConfirm from '@/components/shared/useConfirm';
import type { FormSource } from '../formAnswers';
import type { MirrorSource, SourceError } from '../sourceMirrors';
import type { DtColumn, DtTable } from '../rowBrowser/rowBrowserModel';
import type { Field, DesignerTable, SaveError, ManagedSaveError, ColumnDesignerProps } from '../ColumnDesigner.types';
import { managedProblemText, sourceColumnInfo, managedHint } from './ColumnDesigner.helpers';
import { ColumnRow } from './ColumnRow';
import { DestructiveConfirm } from './DestructiveConfirm';
import { AddColumn, ColumnHead, ColumnNotices, ColumnSaveBar, ColumnsLoading } from './ColumnDesignerParts';

/** The AI draft's columns, keeping the id of every column that already existed under that key. */
function revisedFields(saved: Field[], draftFields: unknown): Field[] {
    const byKey = new Map<string, Field>((saved || []).map(f => [f.key, f]));
    return ((Array.isArray(draftFields) ? draftFields : []) as Field[]).map(f => {
        const prev = byKey.get(f.key);
        return {
            ...(prev?.id ? { id: prev.id } : {}),
            key: f.key, name: f.name, type: f.type,
            ...(f.options ? { options: f.options } : {}),
            ...(f.required ? { required: true } : {}),
            ...(f.unique ? { unique: true } : {}),
        };
    });
}

interface RemoveRetiredArgs {
    t: TranslateFn;
    confirm: ReturnType<typeof useConfirm>['confirm'];
    table: DesignerTable;
    f: Field;
    load: () => Promise<void>;
    onChanged: ColumnDesignerProps['onChanged'];
    setError: (message: string | null) => void;
}

/** Drop the column of a question that is no longer on the form, after asking. */
async function removeRetiredColumn({ t, confirm, table, f, load, onChanged, setError }: RemoveRetiredArgs) {
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
}

/** The table's columns as last saved and as being edited, the schema version, one sample row, and the save state. */
function useColumnSchema(tableId: string, t: TranslateFn) {
    const [fields, setFields] = useState<Field[] | null>(null);
    const [saved, setSaved] = useState<Field[]>([]);
    const [version, setVersion] = useState<number | null>(null);
    const [sample, setSample] = useState<Record<string, unknown> | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirming, setConfirming] = useState<ReturnType<typeof destructiveChanges> | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            // The first row alongside the schema, for the "Example" column —
            // the RowBrowser's own pattern. `allSettled`, because a person
            // who may see the columns and not the rows (or a table that is
            // simply empty) must still get the designer: a sample is a nicety,
            // the column list is the point.
            const [schemaOut, rowsOut] = await Promise.allSettled([
                datatablesApi.getSchema(tableId),
                datatablesApi.listRows(tableId, { limit: 1 }),
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
    }, [tableId, t]);

    useEffect(() => { load(); }, [load]);

    return {
        fields, setFields, saved, setSaved, version, setVersion, sample, error, setError,
        busy, setBusy, confirming, setConfirming, note, setNote, load,
    };
}

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
    const {
        fields, setFields, saved, setSaved, version, setVersion, sample, error, setError,
        busy, setBusy, confirming, setConfirming, note, setNote, load,
    } = useColumnSchema(table.id, t);

    const managedKind = table.managedKind || null;


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
    }, [table, fields, version, onChanged, load, t, setBusy, setConfirming, setError, setNote, setSaved, setVersion]);

    const attemptSave = () => {
        const changes = destructiveChanges(saved, fields);
        if (changes.any) setConfirming(changes);
        else doSave();
    };

    if (fields === null) return <ColumnsLoading t={t} />;

    return (
        <div className="space-y-3.5">
            {confirmDialog}
            <ColumnNotices t={t} answers={answers} schemaLocked={schemaLocked} canEdit={canEdit} sourceName={sourceName} managedKind={managedKind} />

            {/* "Build it with AI" — only on a table whose columns are the
                person's own: a cache, a mirror or a form's answers has a
                contract of its own and gets no box. The draft lands in the
                unsaved list above the Save bar; the guard against removing
                and retyping is explained on the card. */}
            {canEdit && !schemaLocked && !managedKind && fields && (
                <AiTablePanel
                    mode="revise"
                    current={{ name: table.name, description: table.description, rowCount: table.rowCount, managedKind: table.managedKind || null, fields }}
                    onApply={(d) => setFields(revisedFields(saved, d.fields))}
                    testId="columns-ai"
                />
            )}

            {fields.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">
                    {t('datatables.columns_empty', 'No columns yet. Every table already has id, created_at, updated_at and created_by — add the ones your automation needs on top.')}
                </p>
            ) : (
                <div className="overflow-hidden" style={CARD_STYLE}>
                    <ColumnHead t={t} />
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
                                onRemoveRetired={answers && canEditProp && isRetiredFormColumn(table.source as FormSource | null | undefined, f) ? () => removeRetiredColumn({ t, confirm, table, f, load, onChanged, setError }) : null}
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

            {canEdit && <AddColumn t={t} onAdd={add} showHint={fields.length > 1} />}

            {/* aria-live, because every one of these appears WITHOUT the focus
                moving — a screen-reader user pressing Save otherwise hears
                nothing at all, whether it worked or not. */}
            <ColumnDesignerSection problems={problems} managedProblem={managedProblem} t={t} error={error} note={note} />

            {canEdit && dirty && <ColumnSaveBar t={t} busy={busy} disabled={busy || problems.length > 0 || !!managedProblem} onDiscard={() => setFields(saved)} onSave={attemptSave} />}

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

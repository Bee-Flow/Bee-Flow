import { Loader2, Lock, Plus } from 'lucide-react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '@/components/shared/StudioSectionHeader';
import { GRID } from './ColumnRow';
import { BTN } from './DestructiveConfirm';

// The chrome around ColumnDesigner's list: loading, the locked/read-only notices,
// the head row, Add a column, and the save bar.

/** While the schema is read. */
export function ColumnsLoading({ t }: { t: TranslateFn }) {
    return (
        <div className="py-8 flex justify-center text-[var(--text-tertiary)]">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            <span className="sr-only">{t('datatables.loading', 'Loading…')}</span>
        </div>
    );
}

interface ColumnNoticesProps {
    t: TranslateFn;
    answers: boolean;
    schemaLocked: boolean;
    canEdit: boolean;
    sourceName: string;
    managedKind: string | null;
}

/** Why the columns cannot (all) be changed here: a form's questions, a source's columns, no rights, or managed columns. */
export function ColumnNotices({ t, answers, schemaLocked, canEdit, sourceName, managedKind }: ColumnNoticesProps) {
    return (
        <>
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
        </>
    );
}

const HEAD_STYLE = {
    padding: '8px 14px',
    borderBottom: '1px solid var(--border-default)',
    fontSize: 10,
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    fontWeight: 600,
    color: 'var(--text-tertiary)',
};

/** The list's head row. */
export function ColumnHead({ t }: { t: TranslateFn }) {
    return (
        <div className="grid items-center" style={{ ...GRID, ...HEAD_STYLE }} role="presentation">
            <span />
            <span>{t('datatables.col_head_column', 'Column')}</span>
            <span>{t('datatables.col_head_kind', 'Kind')}</span>
            <span>{t('datatables.col_head_example', 'Example')}</span>
            <span />
        </div>
    );
}

/** Add a column, and (from two columns on) how to reorder them. */
export function AddColumn({ t, onAdd, showHint }: { t: TranslateFn; onAdd: () => void; showHint: boolean }) {
    return (
        <>
            <button type="button" onClick={onAdd}
                className="text-xs inline-flex items-center gap-1.5 rounded px-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!">
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('datatables.column_add', 'Add a column')}
            </button>
            {showHint && (
                <p className="text-xs m-0 [color:var(--text-tertiary)]! [line-height:18px]" data-testid="columns-hint">
                    {t('datatables.columns_hint', 'Drag the handle to reorder. Columns an automation writes to are marked; removing one breaks that step until you fix it there.')}
                </p>
            )}
        </>
    );
}

interface ColumnSaveBarProps {
    t: TranslateFn;
    busy: boolean;
    disabled: boolean;
    onDiscard: () => void;
    onSave: () => void;
}

/** Unsaved changes: Discard, or Save columns. */
export function ColumnSaveBar({ t, busy, disabled, onDiscard, onSave }: ColumnSaveBarProps) {
    return (
    <div className="sticky bottom-0 flex items-center gap-2 py-3 -mx-1 px-1 [background:var(--bg-primary)] [border-top:1px_solid_var(--border-default)]">
        <span className="text-xs mr-auto text-[var(--text-tertiary)]">
            {t('datatables.columns_unsaved', 'Unsaved column changes')}
        </span>
        <button type="button" onClick={onDiscard} className={`${BTN} border [border-color:var(--border-default)] [color:var(--text-secondary)] [outline-color:var(--accent-primary)]`}>
            {t('datatables.discard', 'Discard')}
        </button>
        <button
            type="button"
            onClick={onSave}
            disabled={disabled}
            className={`${BTN} font-medium disabled:opacity-50 inline-flex items-center gap-1.5`}
            style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
        >
            {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
            {t('datatables.columns_save', 'Save columns')}
        </button>
    </div>
    );
}

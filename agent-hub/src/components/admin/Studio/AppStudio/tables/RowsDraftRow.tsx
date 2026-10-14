import { Loader2 } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import RowCellEditor from './RowCellEditor';
import type { RelationRow, RowsField, RowsTable } from './RowsTab.types';

/**
 * The row being typed before it is sent: one live cell per column and the
 * Add / Cancel pair. Split out of RowsTab.tsx for its size budget.
 */

interface RowsDraftRowProps {
    columns: RowsField[];
    draft: Record<string, unknown>;
    savingDraft: boolean;
    relationRows: Record<string, RelationRow[]>;
    tableFor: (fieldRef: string) => RowsTable | null;
    onChange: (key: string, value: unknown) => void;
    onSave: () => void;
    onCancel: () => void;
}

export default function RowsDraftRow({
    columns, draft, savingDraft, relationRows, tableFor, onChange, onSave, onCancel,
}: RowsDraftRowProps) {
    const { t } = useTranslation();
    return (
        <tr>
            {columns.map((f) => (
                <td key={f.key} className="border-b px-2 py-1 align-top border-[var(--border-default)]">
                    {f.type === 'computed' ? (
                        <span className="text-xs text-[var(--text-tertiary)]">{t('studio_apps_tables.rows.computed_later', 'Worked out later')}</span>
                    ) : (
                        <RowCellEditor
                            field={f}
                            value={draft[f.key as string] ?? null}
                            live
                            disabled={savingDraft}
                            relationRows={f.relation?.table ? relationRows[f.relation.table] : null}
                            relationTable={f.relation?.table ? tableFor(f.relation.table) : null}
                            onCommit={(v) => onChange(f.key as string, v)}
                        />
                    )}
                </td>
            ))}
            <td className="border-b px-2 py-1 align-middle border-[var(--border-default)]">
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={onSave}
                        disabled={savingDraft}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-white disabled:opacity-50 bg-[var(--accent-primary)]"
                    >
                        {savingDraft ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> : null}
                        {t('studio_apps_tables.rows.add', 'Add')}
                    </button>
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={savingDraft}
                        className="rounded-md border px-2 py-1 text-xs disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        {t('studio_apps_tables.rows.cancel', 'Cancel')}
                    </button>
                </div>
            </td>
        </tr>
    );
}

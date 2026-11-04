import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import type { ConversionEntry } from './fieldConversions';
import Modal from '@/components/shared/Modal';
import useTranslation from '@/hooks/useTranslation';

/**
 * A save changed a field's type, and some rows hold values the new type cannot
 * store (a text that is no number, a value that is not one of the choices).
 * The server refused the save and changed nothing. This dialog says how many
 * values, per field, with a few examples, and saves again only when the owner
 * ticks "clear the values that cannot be converted".
 */
export interface MigrationPreviewDialogProps {
    conversions: ConversionEntry[] | null;
    saving: boolean;
    onCancel: () => void;
    onClearAndSave: () => void;
}

function ConversionRow({ entry }: { entry: ConversionEntry }) {
    const { t } = useTranslation();
    const samples = Array.isArray(entry.samples) ? entry.samples : [];
    return (
        <li className="flex flex-col gap-1 py-1">
            <span className="text-[var(--text-primary)]">
                {t('studio_apps_tables.migration.row', '{field}: {n} of {rows} values cannot become {to}', {
                    field: `${entry.table ?? ''}.${entry.field ?? ''}`, n: entry.unconvertible ?? 0, rows: entry.rows ?? '?', to: entry.to ?? '',
                })}
            </span>
            {samples.length ? (
                <span className="text-xs text-[var(--text-tertiary)]">
                    {t('studio_apps_tables.migration.examples', 'For example: {list}', { list: samples.map((s) => `“${s}”`).join(', ') })}
                </span>
            ) : null}
        </li>
    );
}

export default function MigrationPreviewDialog({ conversions, saving, onCancel, onClearAndSave }: MigrationPreviewDialogProps) {
    const { t } = useTranslation();
    const [clear, setClear] = useState(false);
    const open = !!conversions && conversions.length > 0;
    const close = () => { if (!saving) { setClear(false); onCancel(); } };
    const footer = (
        <div className="flex justify-end gap-2">
            <button type="button" onClick={close} disabled={saving}
                className="rounded-md border px-3 py-1.5 text-sm border-[var(--border-default)] text-[var(--text-secondary)] disabled:opacity-50">
                {t('studio_apps_tables.migration.cancel', 'Back to editing')}
            </button>
            <button type="button" onClick={onClearAndSave} disabled={!clear || saving}
                className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-50">
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                {t('studio_apps_tables.migration.save', 'Save and clear them')}
            </button>
        </div>
    );
    return (
        <Modal open={open} onClose={close} size="md" footer={footer}
            title={t('studio_apps_tables.migration.title', 'Some values cannot be converted')}
            disableBackdropClose={saving} disableEscapeClose={saving}>
            <div className="flex flex-col gap-3 text-sm text-[var(--text-secondary)]">
                <p>{t('studio_apps_tables.migration.what', 'Nothing was saved. These fields hold values their new type cannot store:')}</p>
                <ul className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2" data-testid="migration-conversions">
                    {(conversions || []).map((c) => <ConversionRow key={`${c.tableId ?? c.table}.${c.fieldId ?? c.field}`} entry={c} />)}
                </ul>
                <p>{t('studio_apps_tables.migration.fix', 'Fix those rows first, or clear the values: those cells become empty, every other value is converted.')}</p>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="accent-[var(--accent-primary)]" checked={clear} disabled={saving}
                        onChange={(e) => setClear(e.target.checked)} />
                    {t('studio_apps_tables.migration.clear', 'Clear the values that cannot be converted')}
                </label>
            </div>
        </Modal>
    );
}

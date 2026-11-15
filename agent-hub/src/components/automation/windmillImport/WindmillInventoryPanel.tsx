import useTranslation from '@/hooks/useTranslation';
import { SECONDARY_BTN } from '../Builder/settings/settingsUi';
import useWindmillInventory from './useWindmillInventory';

/**
 * "Found in this Nextcloud": the Windmill flows that listen to this Nextcloud,
 * read by the connector without any Windmill credential. Shown only when the
 * server answers `available: true` with flows; a server without the route, a
 * caller who may not see it, or nothing found shows nothing at all. A
 * connector that did not answer gets one short line and a retry.
 */
export default function WindmillInventoryPanel() {
    const { t } = useTranslation();
    const inventory = useWindmillInventory();
    const data = inventory.data;
    if (data?.unreachable) {
        return (
            <p className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-secondary)]">
                <span>{t('automation_import.inventory_unreachable', 'The Bee Flow app in Nextcloud did not answer, so the Windmill flows there could not be listed.')}</span>
                <button type="button" className={SECONDARY_BTN} disabled={inventory.isFetching} onClick={() => { void inventory.refetch(); }}>
                    {t('automation_import.inventory_retry', 'Try again')}
                </button>
            </p>
        );
    }
    if (!data?.available || data.flows.length === 0) return null;
    return (
        <section aria-label={t('automation_import.inventory_title', 'Found in this Nextcloud')} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3 text-[12px]">
            <h3 className="font-semibold text-[var(--text-primary)]">{t('automation_import.inventory_title', 'Found in this Nextcloud')}</h3>
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                {t('automation_import.inventory_intro', '{count} Windmill flows listen to this Nextcloud. Upload their export, or read them from your Windmill, to convert them.', { count: data.flows.length })}
            </p>
            <ul className="mt-2 space-y-1">
                {data.flows.map((f) => (
                    <li key={f.path} className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                            <span className="font-medium text-[var(--text-primary)] break-words">{f.summary || f.path}</span>
                            <span className="block text-[11px] text-[var(--text-tertiary)] break-all">{f.events.join(', ')}</span>
                        </span>
                        <span className="shrink-0 text-[11px] text-[var(--text-tertiary)]">
                            {f.active ? t('automation_import.inventory_active', 'Active') : t('automation_import.inventory_inactive', 'Off')}
                        </span>
                    </li>
                ))}
            </ul>
        </section>
    );
}

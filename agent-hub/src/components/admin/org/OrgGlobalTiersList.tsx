import { useTranslation } from '@/hooks/useTranslation';

interface GlobalTier {
    id: string;
    label?: string;
    icon?: string;
}

/** The custom tiers the system administrator provides, read-only, under an organisation's own tiers. */
export default function OrgGlobalTiersList({ tiers }: { tiers: GlobalTier[] }) {
    const { t } = useTranslation();
    if (tiers.length === 0) return null;
    return (
        <div className="mt-6 pt-6 border-t border-[var(--border-subtle)]">
            <h4 className="text-sm font-semibold text-[var(--text-primary)] mb-2">{t('admin_org.custom_tiers_global_title', 'Global tiers (read-only)')}</h4>
            <p className="text-xs text-[var(--text-muted)] mb-3">
                {t('admin_org.custom_tiers_global_desc', "These tiers are provided by the system administrator. Your members can see them subject to the group permissions you've set.")}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {tiers.map(tier => (
                    <div key={tier.id} className="px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] flex items-center gap-2">
                        <span className="text-lg">{tier.icon || '✨'}</span>
                        <div className="flex-1 min-w-0">
                            <div className="text-xs font-medium text-[var(--text-primary)] truncate">{tier.label}</div>
                            <div className="text-[10px] text-[var(--text-muted)] truncate">{tier.id}</div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

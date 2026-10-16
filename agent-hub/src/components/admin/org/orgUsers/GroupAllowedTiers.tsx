import { useTranslation } from '../../../../hooks/useTranslation';
import type { CustomTierMeta, OrgGroupRow } from '../useOrgDirectory';

interface TierPill {
    id: string;
    label?: string;
    icon?: string;
    description?: string;
}

const STANDARD_TIERS: TierPill[] = [
    { id: 'fast', label: 'Fast', icon: '⚡' },
    { id: 'thinking', label: 'Thinking', icon: '🧠' },
    { id: 'writer', label: 'Writer', icon: '✍️' },
    { id: 'pro', label: 'Deep Thinking', icon: '✨' },
];

interface GroupAllowedTiersProps {
    group: OrgGroupRow;
    customTiersMeta: CustomTierMeta[];
    onChange: (groupId: string, allowedTiers: string[]) => void;
}

/** Allowed tiers — standard + custom. Empty array = no restriction (all tiers). */
export default function GroupAllowedTiers({ group, customTiersMeta, onChange }: GroupAllowedTiersProps) {
    const { t } = useTranslation();
    const allowed = Array.isArray(group.allowedTiers) ? group.allowedTiers : [];
    const unrestricted = allowed.length === 0;
    const toggleTier = (tierId: string) => {
        const set = new Set(allowed);
        if (set.has(tierId)) set.delete(tierId);
        else set.add(tierId);
        onChange(group.id, Array.from(set));
    };
    const clearAll = () => onChange(group.id, []);
    const renderPill = (tier: TierPill, accent: string) => {
        // When unrestricted, render pills muted as inactive so clicking
        // feels like "selecting this one tier to restrict to" rather than
        // deselecting from an all-selected state.
        const active = !unrestricted && allowed.includes(tier.id);
        return (
            <button
                key={tier.id}
                type="button"
                onClick={() => toggleTier(tier.id)}
                className="px-2.5 py-1 rounded-full text-xs font-medium transition-all"
                style={{
                    background: active ? accent : 'var(--bg-primary)',
                    color: active ? '#fff' : 'var(--text-muted)',
                    border: `1px solid ${active ? accent : 'var(--border-subtle)'}`,
                }}
                title={tier.description || ''}
            >
                {tier.icon || '✨'} {tier.label || tier.id}
            </button>
        );
    };
    return (
        <div className="flex items-start gap-2">
            <label className="text-xs text-[var(--text-secondary)] w-24 pt-1.5 shrink-0">{t('admin_org.users_allowed_tiers', 'Allowed tiers')}</label>
            <div className="flex-1 space-y-2">
                <div className="flex flex-wrap gap-1.5">
                    {STANDARD_TIERS.map(tier => renderPill(tier, 'rgb(59, 130, 246)'))}
                    {customTiersMeta.map(tier => renderPill(tier, 'rgb(234, 179, 8)'))}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] flex items-center gap-3">
                    {unrestricted ? (
                        <span>{t('admin_org.users_no_restriction', 'No restriction set: members can use every tier. Click a pill to restrict access to only selected tiers.')}</span>
                    ) : (
                        <>
                            <span>{allowed.length === 1 ? t('admin_org.users_tier_permitted_one', '{n} tier permitted. Members of other groups may still see additional tiers through those groups.', { n: allowed.length }) : t('admin_org.users_tier_permitted_other', '{n} tiers permitted. Members of other groups may still see additional tiers through those groups.', { n: allowed.length })}</span>
                            <button
                                type="button"
                                onClick={clearAll}
                                className="underline hover:text-[var(--text-primary)]"
                            >
                                {t('admin_org.users_clear_restrictions', 'Clear restrictions')}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

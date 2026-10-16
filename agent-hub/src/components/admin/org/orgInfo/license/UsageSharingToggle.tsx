import { Users } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useLicenseText } from './licenseShared';
import type { OrgUsageData } from './licenseShared';

interface UsageSharingToggleProps<T extends OrgUsageData> {
    orgData: T;
    setOrgData: Dispatch<SetStateAction<T | null>>;
}

/**
 * AI usage sharing (moved here from Org Info). The toggle merely splits the
 * plan's cost budget, so the caller shows it only when there is one.
 */
export default function UsageSharingToggle<T extends OrgUsageData>({ orgData, setOrgData }: UsageSharingToggleProps<T>) {
    const { t } = useLicenseText();
    return (
        <div className="space-y-3 pt-2">
            <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('org.share_usage', 'AI usage sharing')}</h3>
                <p className="text-[12px] text-[var(--text-muted)] mt-0.5">{t('org.share_usage_desc', 'Choose whether your team shares one AI-usage budget, or whether each user gets their own slice.')}</p>
            </div>
            <div className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: 'rgba(16,185,129,0.12)' }}>
                    <Users className="w-4 h-4" style={{ color: '#10b981' }} />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-medium text-[var(--text-primary)]">{t('org.share_usage_label', 'Share AI usage across the organisation')}</p>
                    <p className="text-[11px] text-[var(--text-muted)] mt-0.5 mb-3">{t('org.share_usage_explainer', 'When on, every user shares the plan\'s cost budget. When off, the budget is divided equally between active users so each user gets their own slice for the period.')}</p>
                    <label className="inline-flex items-center gap-3 cursor-pointer select-none">
                        <span className="relative inline-flex h-5 w-9 items-center">
                            <input
                                type="checkbox"
                                checked={!!orgData.usagePooled}
                                onChange={e => setOrgData(p => ({ ...p, usagePooled: e.target.checked }) as T)}
                                className="sr-only peer"
                            />
                            <span className="absolute inset-0 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-default)] peer-checked:bg-emerald-500 peer-checked:border-emerald-500 transition-colors" />
                            <span className="absolute left-0.5 top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
                        </span>
                        <span className="text-[12px] text-[var(--text-secondary)]">
                            {orgData.usagePooled
                                ? t('org.share_usage_on', 'Pooled across the organisation')
                                : t('org.share_usage_off', 'Each user has their own budget')}
                        </span>
                    </label>
                </div>
            </div>
        </div>
    );
}

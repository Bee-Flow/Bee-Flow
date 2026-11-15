import type { Dispatch, SetStateAction } from 'react';
import { useLicenseText } from './licenseShared';
import type { OrgUsageData } from './licenseShared';
import Toggle from '@/components/shared/Toggle';

interface UsageSharingToggleProps<T extends OrgUsageData> {
    orgData: T;
    setOrgData: Dispatch<SetStateAction<T | null>>;
}

/**
 * AI usage sharing. The switch merely splits the plan's cost budget, so the
 * caller shows it only when there is one. It is a field of this row's form,
 * saved with the row's save bar (useOrgInfoForm 'license').
 */
export default function UsageSharingToggle<T extends OrgUsageData>({ orgData, setOrgData }: UsageSharingToggleProps<T>) {
    const { t } = useLicenseText();
    return (
        <div className="space-y-3 pt-2">
            <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('org.share_usage', 'AI usage sharing')}</h3>
                <p className="text-[12px] text-[var(--text-muted)] mt-0.5">{t('org.share_usage_desc', 'Choose whether your team shares one AI-usage budget, or whether each user gets their own slice.')}</p>
            </div>
            <Toggle
                checked={!!orgData.usagePooled}
                onChange={(next) => setOrgData(p => ({ ...p, usagePooled: next }) as T)}
                label={t('org.share_usage_label', 'Share AI usage across the organisation')}
                description={(
                    <>
                        {t('org.share_usage_explainer', 'When on, every user shares the plan\'s cost budget. When off, the budget is divided equally between active users so each user gets their own slice for the period.')}
                        {' '}
                        <span className="font-medium text-[var(--text-secondary)]">
                            {orgData.usagePooled
                                ? t('org.share_usage_on', 'Pooled across the organisation')
                                : t('org.share_usage_off', 'Each user has their own budget')}
                        </span>
                    </>
                )}
            />
        </div>
    );
}

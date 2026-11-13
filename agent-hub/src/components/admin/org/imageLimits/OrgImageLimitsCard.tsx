import { ImageIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { EMPTY_IMAGE_LIMITS_INPUT } from '@/utils/imageLimits';
import type { ImageLimitsInput } from '@/utils/imageLimits';
import ImageLimitsField from './ImageLimitsField';

interface OrgImageLimitsCardProps<T extends { imageLimits?: ImageLimitsInput }> {
    orgData: T;
    setOrgData: Dispatch<SetStateAction<T | null>>;
}

/**
 * The organisation's default image limits per user, part of the organisation
 * form (its save bar sends them). Groups and users can set their own, which
 * come first.
 */
export default function OrgImageLimitsCard<T extends { imageLimits?: ImageLimitsInput }>({ orgData, setOrgData }: OrgImageLimitsCardProps<T>) {
    const { t } = useTranslation();
    return (
        <div className="space-y-3 pt-2">
            <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('image_limits.org_title', 'Image limits')}</h3>
                <p className="text-[12px] text-[var(--text-muted)] mt-0.5">{t('image_limits.org_desc', 'How many images each user may generate. This is the default for everyone; a group or a user can have their own limits, which come first.')}</p>
            </div>
            <div className="p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-start gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5 bg-[var(--bg-tertiary)]">
                    <ImageIcon className="w-4 h-4 text-[var(--accent-primary)]" />
                </div>
                <div className="flex-1 min-w-0">
                    <ImageLimitsField
                        value={orgData.imageLimits ?? EMPTY_IMAGE_LIMITS_INPUT}
                        onChange={v => setOrgData(p => (p ? { ...p, imageLimits: v } : p))}
                        label={t('image_limits.org_label', 'Images per user')}
                    />
                </div>
            </div>
        </div>
    );
}

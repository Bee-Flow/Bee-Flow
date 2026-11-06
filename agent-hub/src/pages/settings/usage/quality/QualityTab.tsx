import { useState } from 'react';
import OrgFeedbackPanel from '@/pages/settings/OrgFeedbackPanel';
import OrgTerminationsPanel from '@/pages/settings/OrgTerminationsPanel';
import { useTranslation } from '@/hooks/useTranslation';
import type { RangeParams } from '@/utils/usageHelpers';
import { SubTabs } from '../shell';

export interface QualityTabProps {
    rangeParams: RangeParams;
    showTokens: boolean;
    compare: boolean;
    initialSubTab?: string;
}

/** Stub until the Quality redesign lands: the two existing panels under sub-tabs. */
export default function QualityTab({ rangeParams, showTokens, initialSubTab }: QualityTabProps) {
    const { t } = useTranslation();
    const [sub, setSub] = useState<string>(initialSubTab === 'terminations' ? 'terminations' : 'feedback');
    return (
        <div className="flex flex-col gap-4">
            <SubTabs
                value={sub}
                onChange={setSub}
                aria-label={t('usage.tab_quality', 'Quality')}
                options={[
                    { id: 'feedback', label: t('usage.quality_sub_feedback', 'Feedback') },
                    { id: 'terminations', label: t('usage.quality_sub_terminations', 'Terminations') },
                ]}
            />
            {sub === 'feedback'
                ? <OrgFeedbackPanel rangeParams={rangeParams} showTokens={showTokens} />
                : <OrgTerminationsPanel rangeParams={rangeParams} showTokens={showTokens} />}
        </div>
    );
}

import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import OrgFeedbackPanel from '@/pages/settings/OrgFeedbackPanel';
import OrgTerminationsPanel from '@/pages/settings/OrgTerminationsPanel';
import { useTranslation } from '@/hooks/useTranslation';
import type { RangeParams } from '@/utils/usageHelpers';
import { SubTabs } from '../shell';
import { ApprovalCard, TerminationsCard } from './QualityHero';
import { QualityRevealBanner } from './QualityRevealBanner';
import { largeInputCount } from './qualityModel';
import { useQualityReports } from './useQualityReports';

export interface QualityTabProps {
    rangeParams: RangeParams;
    showTokens: boolean;
    initialSubTab?: string;
    /** All AI calls in the range, when the page knows them. */
    totalCalls?: number;
}

const NO_SUMMARY = { total: 0, thumbs_up: 0, thumbs_down: 0, with_comments: 0 };

export default function QualityTab({ rangeParams, showTokens, initialSubTab, totalCalls }: QualityTabProps) {
    const { t } = useTranslation();
    const [sub, setSub] = useState<string>(initialSubTab === 'terminations' ? 'terminations' : 'feedback');
    const { feedback, terminations, revealFeedback, revealTerminations, banner } = useQualityReports(rangeParams, sub);
    const tData = terminations.data;
    const description = sub === 'feedback'
        ? t('org.quality_desc_feedback', 'Feedback: what people said about an answer. Messages are only shown when the person shared the conversation.')
        : t('org.quality_desc_terminations', 'Terminations: tasks that ended early, by agent and over time. Messages are never logged.');
    const refreshing = feedback.isFetching || terminations.isFetching;
    const refresh = () => { void feedback.refetch(); void terminations.refetch(); };
    return (
        <div className="flex flex-col gap-5">
            <section aria-label={t('org.quality_summary', 'Quality summary')} className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))]">
                <ApprovalCard summary={feedback.data?.summary ?? NO_SUMMARY} totalCalls={totalCalls} />
                <TerminationsCard
                    total={tData?.summary?.total ?? 0}
                    byType={tData?.summary?.by_type}
                    largeInput={largeInputCount(tData?.rows ?? [], showTokens)}
                    totalCalls={totalCalls}
                />
            </section>
            <SubTabs
                value={sub}
                onChange={setSub}
                aria-label={t('org.quality_views', 'Quality views')}
                description={description}
                actions={(
                    <button
                        type="button"
                        onClick={refresh}
                        disabled={refreshing}
                        aria-label={t('org.quality_refresh', 'Refresh')}
                        title={t('org.quality_refresh', 'Refresh')}
                        className="ml-auto inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border border-[var(--border-subtle)] bg-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:cursor-default disabled:opacity-60"
                    >
                        <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
                    </button>
                )}
                options={[
                    { id: 'feedback', label: t('usage.quality_sub_feedback', 'Feedback') },
                    { id: 'terminations', label: t('usage.quality_sub_terminations', 'Terminations') },
                ]}
            />
            <QualityRevealBanner {...banner} />
            {sub === 'feedback'
                ? <OrgFeedbackPanel rangeParams={rangeParams} showTokens={showTokens} reveal={revealFeedback} />
                : <OrgTerminationsPanel rangeParams={rangeParams} showTokens={showTokens} reveal={revealTerminations} />}
        </div>
    );
}

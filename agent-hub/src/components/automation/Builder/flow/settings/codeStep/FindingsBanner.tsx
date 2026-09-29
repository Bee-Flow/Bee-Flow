// The checks, summed up in the step's small view: one calm line, and the way
// to the large editor where they can be fixed. Silent when there is nothing
// to say. Only a block stops the step; a warning is worth a look, never a gate.
import { AlertOctagon, AlertTriangle } from 'lucide-react';
import type { CodeAnalysis } from '../../../../../../api/queries/automation/codeStep';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { checksState } from './codeParams';

interface FindingsBannerProps {
    analysis: CodeAnalysis | null | undefined;
    allowedTools: string[];
    onOpen: () => void;
}

export default function FindingsBanner({ analysis, allowedTools, onOpen }: FindingsBannerProps) {
    const { t } = useTranslation();
    if (!analysis) return null;
    const state = checksState(analysis, allowedTools);
    const blocked = !!analysis.syntaxError || state.blocks.length > 0;
    if (!blocked && state.toReview.length === 0) return null;
    const Icon = blocked ? AlertOctagon : AlertTriangle;
    const tone = blocked
        ? 'border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_7%,transparent)] text-[var(--error)]'
        : 'border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] text-[var(--text-primary)]';
    let text = t('code_step.banner.blocked', 'This step cannot run until its code is fixed.');
    if (!blocked) {
        text = state.toReview.length === 1
            ? t('code_step.banner.review_one', 'One thing in this code is worth a look.')
            : t('code_step.banner.review', '{count} things in this code are worth a look.', { count: state.toReview.length });
    }
    return (
        <div role="status" data-testid="code-findings-banner" className={`flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs ${tone}`}>
            <Icon size={14} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{text}</span>
            <button type="button" onClick={onOpen} className="shrink-0 font-semibold underline underline-offset-2 hover:no-underline">
                {blocked ? t('code_step.banner.see', 'See what to fix') : t('code_step.banner.review_action', 'Review')}
            </button>
        </div>
    );
}

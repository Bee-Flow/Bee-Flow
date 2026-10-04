import { ShieldAlert, ShieldCheck } from 'lucide-react';
import type { ScanMode, ScanSummary } from '../../../../../api/queries/automation/repeating';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { eventsText } from './patternView';
import { DetailsToggle } from './ScanFlow';
import type { SourceStep } from './useRepeatingScan';

/** "Looked at Mail, Files · 412 events · no personal data found", as parts. */
export function summaryParts(summary: ScanSummary | null, labelFor: (id: string) => string, t: TranslateFn): string[] {
    if (!summary) return [];
    const parts: string[] = [];
    const looked = summary.sources ?? summary.integrations ?? [];
    if (looked.length) parts.push(t('automations.repeating.lookedAt', 'Looked at {apps}', { apps: looked.map(labelFor).join(', ') }));
    if (typeof summary.events === 'number') parts.push(eventsText(summary.events, t));
    else if (summary.toolCalls === 1) parts.push(t('automations.repeating.oneRead', '1 read'));
    else if (typeof summary.toolCalls === 'number') parts.push(t('automations.repeating.reads', '{count} reads', { count: summary.toolCalls }));
    if (looked.length) {
        const pii = summary.piiCategories ?? [];
        parts.push(pii.length
            ? t('automations.repeating.personalData', 'personal data found: {categories}', { categories: pii.join(', ') })
            : t('automations.repeating.noPersonalData', 'no personal data found'));
    }
    return parts;
}

/**
 * Under a finished scan: what it read and what the Privacy Shield found, the
 * promise that only patterns reached the AI (a patterns scan; an ideas-shaped
 * summary, with `integrations`, came from the AI reading Shield-checked tool
 * output, so it says that instead), what was skipped, and the log toggle.
 */
export default function PrivacyFootnote({ mode, summary, steps, labelFor, detailsOpen, onToggleDetails }: {
    mode: ScanMode;
    summary: ScanSummary | null;
    steps: SourceStep[];
    labelFor: (id: string) => string;
    detailsOpen: boolean;
    onToggleDetails: () => void;
}) {
    const { t } = useTranslation();
    const parts = summaryParts(summary, labelFor, t);
    const skipped = [...new Set(steps.filter(s => s.status === 'skipped').map(s => labelFor(s.app)))];
    if (!parts.length && !steps.length) return null;
    return (
        <div className="flex flex-col gap-1 text-[11px] text-[var(--text-tertiary)]" data-testid="privacy-footnote">
            <div className="flex items-center gap-1.5 flex-wrap">
                <ShieldCheck size={12} aria-hidden="true" className="text-[var(--success)] shrink-0" />
                {parts.length > 0 && <span>{parts.join(' · ')}</span>}
                {steps.length > 0 && <DetailsToggle open={detailsOpen} onToggle={onToggleDetails} />}
            </div>
            <p className="m-0 pl-[18px]">
                {mode === 'patterns' && !summary?.integrations
                    ? t('automations.repeating.privacyPatterns', 'No message text was sent to the AI, only patterns.')
                    : t('automations.repeating.privacyIdeas', 'Privacy Shield checked everything Bee read before the AI saw it.')}
            </p>
            {skipped.length > 0 && (
                <div className="flex items-center gap-1.5 text-[var(--warning)]">
                    <ShieldAlert size={12} aria-hidden="true" className="shrink-0" />
                    <span>{t('automations.repeating.skippedSources', 'Bee skipped {apps} this time. The details say why.', { apps: skipped.join(', ') })}</span>
                </div>
            )}
        </div>
    );
}

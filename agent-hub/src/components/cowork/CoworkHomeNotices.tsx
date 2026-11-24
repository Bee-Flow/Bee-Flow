/**
 * The two notices of the Cowork home, under the composer, each only while it holds:
 *
 *   budget     the organisation used 80% or more of this month's Cowork AI budget (GET /api/cowork/home `budget`):
 *              amber "used 86%… tasks wait until 1 December", red once it is used up;
 *   read-only  the organisation switched Cowork to read-only (GET /api/cowork/policy/mine): tasks read and draft,
 *              but change and send nothing.
 */
import { AlertTriangle, Info } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMyCoworkPolicy } from '@/api/coworkPolicy';
import { useTranslation } from '@/hooks/useTranslation';

const TONE = {
    warn: 'border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_9%,transparent)] text-[var(--warning-ink)]',
    bad: 'border-[color-mix(in_srgb,var(--error)_30%,transparent)] bg-[color-mix(in_srgb,var(--error)_7%,transparent)] text-[var(--error-ink)]',
    plain: 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
} as const;

function Notice({ tone, children, testId }: { tone: keyof typeof TONE; children: ReactNode; testId: string }) {
    const Icon = tone === 'plain' ? Info : AlertTriangle;
    return (
        <div role="status" data-testid={testId} className={`rounded-[14px] border px-3.5 py-3 flex items-start gap-2.5 text-[14px] ${TONE[tone]}`}>
            <Icon aria-hidden="true" className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{children}</span>
        </div>
    );
}

/** The first of next month, as "1 December" in the reader's language. */
function nextMonthStart(locale: string, now: Date = new Date()): string {
    return new Date(now.getFullYear(), now.getMonth() + 1, 1, 12).toLocaleDateString(locale, { day: 'numeric', month: 'long' });
}

export default function CoworkHomeNotices({ budgetPercent }: { budgetPercent: number | null | undefined }) {
    const { t, locale } = useTranslation();
    const readOnly = useMyCoworkPolicy().data?.readOnly === true;
    const lang = locale || 'en';
    const percent = typeof budgetPercent === 'number' ? budgetPercent : 0;
    const date = nextMonthStart(lang);
    return (
        <>
            {percent >= 100 && (
                <Notice tone="bad" testId="cowork-budget-notice">
                    {t('cowork_home.notice.budget_over', 'Your organisation’s AI budget for this month is used up. Tasks do not run until {date}, or until an admin raises it.', { date })}
                </Notice>
            )}
            {percent >= 80 && percent < 100 && (
                <Notice tone="warn" testId="cowork-budget-notice">
                    {t('cowork_home.notice.budget_close', 'Your organisation has used {percent}% of this month’s AI budget. When it is used up, tasks wait until {date}.', { percent, date })}
                </Notice>
            )}
            {readOnly && (
                <Notice tone="plain" testId="cowork-read-only-notice">
                    {t('cowork_home.notice.read_only', 'Read-only mode is on for your organisation. Tasks read and write drafts, but change and send nothing.')}
                </Notice>
            )}
        </>
    );
}

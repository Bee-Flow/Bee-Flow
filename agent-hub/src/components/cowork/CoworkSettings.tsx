/**
 * The Settings tab of an item (./CoworkDetail.tsx): how it starts, the people it is shared with or handed to (and the
 * desk it works on with colleagues' coworks, ./CoworkDeskPanel.tsx), its
 * monthly AI budget, and the changes made to it. Plain headed sections in one column, each open: what used to be four
 * folded boxes of the same look is now read as one page.
 *
 * Rendered only while the tab is shown, so the panels below read their data then and not when the item opens.
 */
import type { ReactNode } from 'react';
import CoworkDeskPanel from './CoworkDeskPanel';
import CoworkHandOver from './CoworkHandOver';
import CoworkSaveTemplate from './CoworkSaveTemplate';
import { ReceiptChain } from './CoworkReceipt';
import CoworkShare from './CoworkShare';
import CoworkStartPanel from './CoworkStartPanel';
import CoworkTrail from './CoworkTrail';
import { useTranslation } from '@/hooks/useTranslation';
import { formatCost } from '@/utils/formatCost';
import type { CoworkItem } from '@/api/cowork.types';
import type { TranslateFn } from '@/hooks/useTranslation';

function Section({ id, heading, children }: { id: string; heading: string; children: ReactNode }) {
    const headingId = `cowork-settings-${id}-heading`;
    return (
        <section
            aria-labelledby={headingId}
            data-testid={`cowork-settings-${id}`}
            className="flex flex-col gap-2.5 pt-4 first:pt-0 border-t first:border-t-0 border-[var(--border-subtle)]"
        >
            <h3 id={headingId} className="text-[13px] font-semibold text-[var(--text-primary)]">{heading}</h3>
            {children}
        </section>
    );
}

/** The budget as it is set, read-only: it is changed in the edit form, with the rest of what the item is. */
function Budget({ amount, t, locale, busy, onEdit }: { amount: number | null; t: TranslateFn; locale: string; busy?: boolean; onEdit: () => void }) {
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5" data-testid="cowork-settings-budget-value">
            <p className="text-[12.5px] text-[var(--text-secondary)]">
                {amount === null
                    ? t('cowork_detail.budget.none', 'No limit on what it may spend on AI.')
                    : t('cowork_detail.budget.amount', '{amount} a month on AI. At that amount it pauses itself and tells you.', { amount: formatCost({ EUR: amount }, locale) })}
            </p>
            <button
                type="button"
                disabled={busy}
                onClick={onEdit}
                className="text-[12px] font-medium underline underline-offset-2 disabled:opacity-50 text-[var(--accent-primary)]"
            >
                {t('cowork_detail.budget.change', 'Change it in Edit')}
            </button>
        </div>
    );
}

interface CoworkSettingsProps {
    item: CoworkItem;
    busy?: boolean;
    /** Opens the edit form, where the budget is set. */
    onEdit: () => void;
}

export default function CoworkSettings({ item, busy, onEdit }: CoworkSettingsProps) {
    const { t, locale } = useTranslation();
    const budget = typeof item.monthlyBudget === 'number' ? item.monthlyBudget : null;
    return (
        <div className="flex flex-col gap-4" data-testid="cowork-settings">
            <Section id="start" heading={t('cowork_detail.settings.start', 'How it starts')}>
                <CoworkStartPanel item={item} />
            </Section>
            <Section id="people" heading={t('cowork_detail.settings.people', 'People')}>
                <CoworkShare coworkId={item.id} />
                <CoworkDeskPanel coworkId={item.id} />
                <CoworkHandOver coworkId={item.id} />
                <CoworkSaveTemplate coworkId={item.id} title={item.title} />
            </Section>
            <Section id="budget" heading={t('cowork_detail.settings.budget', 'Budget')}>
                <Budget amount={budget} t={t} locale={locale} busy={busy} onEdit={onEdit} />
            </Section>
            <Section id="changes" heading={t('cowork_detail.settings.changes', 'Changes')}>
                <CoworkTrail coworkId={item.id} />
                <ReceiptChain coworkId={item.id} />
            </Section>
        </div>
    );
}

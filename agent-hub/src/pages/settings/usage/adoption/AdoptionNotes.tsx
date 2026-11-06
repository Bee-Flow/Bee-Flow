import { Info, ShieldCheck } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { Card } from '../kit';

/**
 * The two footer notes of the Adoption tab: who may see this report and on
 * what terms, and how the numbers are made (what is counted, for whom, and
 * what is not metered yet).
 */
export default function AdoptionNotes() {
    const { t } = useTranslation();
    return (
        <div id="adoption-notes" className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(300px,1fr))]">
            <Card title={t('adoption.notes_who_title', 'Who can see this')} icon={ShieldCheck}>
                <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
                    {t('adoption.notes_who_body', 'Organisation admins and holders of the Monitoring permission. Per-person figures are pseudonymous until revealed, every reveal is audited, and health-related categories are never shown next to a person. Make sure your staff notice names Usage & Monitoring.')}
                </p>
                <a href="/app/settings/organisation/compliance" className="mt-2 inline-block text-[11px] text-[var(--text-secondary)] underline underline-offset-2">
                    {t('adoption.notes_who_link', 'Compliance › Monitoring notice')}
                </a>
            </Card>
            <Card title={t('adoption.notes_how_title', 'How the numbers are made')} icon={Info}>
                <p className="text-[12px] leading-relaxed text-[var(--text-secondary)]">
                    {t('adoption.notes_how_body', 'Every AI call is one row in the usage ledger, priced at the rate in force that day. A run started by a colleague counts for that colleague, not for the builder. Tool-call rows are excluded from totals. Kinds without a usage signal say so instead of showing zero; nothing records which pages, apps or documents people open.')}
                </p>
                <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                    {t('adoption.notes_how_unmetered', 'Not metered on every server yet: voice, dictation and the Nextcloud assistant. Their spend is missing from these totals until they are.')}
                </p>
            </Card>
        </div>
    );
}

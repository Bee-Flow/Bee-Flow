import { Eye, EyeOff, ShieldAlert } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { localeFormat } from '@/hooks/useLocaleFormat';
import { AlertBanner } from '../kit';
import type { PeopleTableProps } from './PeopleTable';

const BOX = 'mb-2 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3';
const BUTTON = 'inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-default,var(--border-subtle))] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]';

type BannerProps = Pick<PeopleTableProps, 'view' | 'revealed' | 'auditFailed' | 'revealedAt' | 'scopeLabel' | 'onReveal' | 'onHide' | 'loading'>;

/** The reveal's moment in the app's language (`locale`: resolvedLocale), not the browser's. */
function fTime(ms: number | null, locale: string | null | undefined): string {
    if (!ms) return '';
    return localeFormat(locale).dateTime(ms);
}

/**
 * The privacy state of the people table, above it: names hidden (with the
 * one-click reveal), names shown (what the audit log recorded, and the way
 * back), or the reveal refused because the audit log could not record it.
 */
export function PeopleBanner({ view, revealed, auditFailed, revealedAt, scopeLabel, onReveal, onHide, loading }: BannerProps) {
    const { t, resolvedLocale } = useTranslation();
    if (auditFailed) {
        return (
            <div className="mb-2">
                <AlertBanner severity="red" icon={ShieldAlert}
                    title={t('adoption.people_audit_failed_title', 'Names not revealed')}
                    message={t('adoption.people_audit_failed', 'The access audit log could not record the reveal, so nothing is shown. Try again later.')}
                    ctaLabel={t('adoption.people_back', 'Back to pseudonyms')} onCta={onHide} />
            </div>
        );
    }
    if (revealed && view?.reveal) {
        return (
            <div className={BOX} role="status">
                <Eye className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-semibold text-[var(--text-primary)]">{t('adoption.people_revealed_title', 'Names shown · recorded in the access audit log')}</p>
                    <p className="text-[11px] text-[var(--text-muted)]">
                        {t('adoption.people_revealed_detail', 'Entry “usage_adoption_people_revealed” · you · {time} · {scope}. Names stay visible until you leave this page.', { time: fTime(revealedAt, resolvedLocale), scope: scopeLabel })}
                    </p>
                </div>
                <button type="button" onClick={onHide} className={BUTTON}><EyeOff className="h-3.5 w-3.5" aria-hidden="true" />{t('adoption.people_hide', 'Hide names')}</button>
            </div>
        );
    }
    return (
        <div className={BOX}>
            <EyeOff className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <p className="text-[12px] font-semibold text-[var(--text-primary)]">{t('adoption.people_hidden_title', 'Names are hidden')}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                    {t('adoption.people_hidden_detail', 'Each row is a stable pseudonym. Revealing names is recorded in the access audit log with your name, the time and the filter in use.')}
                </p>
            </div>
            <button type="button" onClick={onReveal} disabled={revealed && loading} className={BUTTON}>
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                {revealed && loading ? t('adoption.people_revealing', 'Revealing…') : t('adoption.people_reveal', 'Reveal names')}
            </button>
        </div>
    );
}

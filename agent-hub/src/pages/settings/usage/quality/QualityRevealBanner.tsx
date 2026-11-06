import { Eye, EyeOff, ShieldAlert } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { AlertBanner } from '../kit';

const BOX = 'flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3';
const BUTTON = 'inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border-default,var(--border-subtle))] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:cursor-default disabled:opacity-60';

export interface QualityRevealBannerProps {
    /** The admin asked for names (the click is page-local and resets on leaving). */
    revealed: boolean;
    /** The server answered with names. */
    shown: boolean;
    /** The reveal was refused because the access audit log could not record it. */
    auditFailed: boolean;
    /** When the revealed answer arrived (epoch ms). */
    revealedAt: number | null;
    scopeLabel: string;
    loading: boolean;
    onReveal: () => void;
    onHide: () => void;
}

function fTime(ms: number | null): string {
    if (!ms) return '';
    return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * The privacy state of the Quality lists, above them, as the Adoption people
 * table shows it: names hidden (with the one-click reveal), names shown (what
 * the audit log recorded, and the way back), or the reveal refused because the
 * audit log could not record it.
 */
export function QualityRevealBanner({ revealed, shown, auditFailed, revealedAt, scopeLabel, loading, onReveal, onHide }: QualityRevealBannerProps) {
    const { t } = useTranslation();
    if (auditFailed) {
        return (
            <AlertBanner severity="red" icon={ShieldAlert}
                title={t('org.quality_people_audit_failed_title', 'Names not revealed')}
                message={t('org.quality_people_audit_failed', 'The access audit log could not record the reveal, so nothing is shown. Try again later.')}
                ctaLabel={t('org.quality_people_back', 'Back to pseudonyms')} onCta={onHide} />
        );
    }
    if (revealed && shown) {
        return (
            <div className={BOX} role="status">
                <Eye className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <p className="m-0 text-[12px] font-semibold text-[var(--text-primary)]">{t('org.quality_people_revealed_title', 'Names shown · recorded in the access audit log')}</p>
                    <p className="m-0 text-[11px] text-[var(--text-muted)]">
                        {t('org.quality_people_revealed_detail', 'Entry “usage_quality_people_revealed” · you · {time} · {scope}. Names stay visible until you leave this page.', { time: fTime(revealedAt), scope: scopeLabel })}
                    </p>
                </div>
                <button type="button" onClick={onHide} className={BUTTON}><EyeOff className="h-3.5 w-3.5" aria-hidden="true" />{t('org.quality_people_hide', 'Hide names')}</button>
            </div>
        );
    }
    return (
        <div className={BOX}>
            <EyeOff className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <p className="m-0 text-[12px] font-semibold text-[var(--text-primary)]">{t('org.quality_people_hidden_title', 'Names are hidden')}</p>
                <p className="m-0 text-[11px] text-[var(--text-muted)]">
                    {t('org.quality_people_hidden_detail', 'Each person is a stable pseudonym, the same one the Adoption tab uses. Revealing names is recorded in the access audit log with your name, the time and the period in use.')}
                </p>
            </div>
            <button type="button" onClick={onReveal} disabled={revealed && loading} className={BUTTON}>
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                {revealed && loading ? t('org.quality_people_revealing', 'Revealing…') : t('org.quality_people_reveal', 'Reveal names')}
            </button>
        </div>
    );
}

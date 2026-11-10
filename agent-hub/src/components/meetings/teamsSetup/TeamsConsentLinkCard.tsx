import { Copy, ExternalLink, KeyRound, Loader2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import useCopyToClipboard from '@/hooks/useCopyToClipboard';
import { useCreateTeamsConsentLink } from '@/api/queries/teamsSetup';
import { messageOf } from '@/utils/caughtError';
import { codeText, fixText, fixerText } from './checkText';
import type { ConsentUnavailableReason } from './types';

const BUTTON = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium border disabled:opacity-40 border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]';

/** What to do when no link can be made, per reason (the same remediations as the org.consent_link check). */
const REASON_FIX: Record<ConsentUnavailableReason, string> = {
    tenant_unknown: 'teams_setup.fix.sign_in_with_microsoft_or_set_tenant',
    tenant_consumers: 'teams_setup.fix.tenant_not_consumers',
    app_not_configured: 'teams_setup.fix.configure_app_registration',
};

/**
 * The admin consent link for the organisation's Microsoft tenant (POST
 * /api/teams-setup/org/consent-link). The org admin opens it as an Entra administrator or
 * forwards it to one. The server remembers the request in this browser's session, so the
 * answer is only recorded when it comes back here within the time shown.
 */
export default function TeamsConsentLinkCard() {
    const { t } = useTranslation();
    const create = useCreateTeamsConsentLink();
    const { copy, copied } = useCopyToClipboard();
    const link = create.data;
    const busy = create.isPending;
    const expiresMs = link?.available ? Date.parse(link.expiresAt) : NaN;

    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-5 py-4" data-testid="teams-consent-link">
            <div className="flex items-center gap-2 mb-1">
                <KeyRound className="w-4 h-4 text-[var(--accent-secondary)]" aria-hidden="true" />
                <h4 className="text-[13px] font-semibold text-[var(--text-primary)]">{t('teams_setup.consent.title')}</h4>
            </div>
            <p className="text-[12px] text-[var(--text-muted)]">{t('teams_setup.consent.intro')}</p>
            <ul className="mt-2 list-disc pl-5 text-[11px] text-[var(--text-muted)]">
                <li>{t('teams_setup.consent.roles_delegated')}</li>
                <li>{t('teams_setup.consent.roles_application')}</li>
            </ul>

            {!link?.available && (
                <button type="button" onClick={() => create.mutate()} disabled={busy} className={`mt-3 ${BUTTON}`}>
                    {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
                    {busy ? t('teams_setup.consent.creating') : t('teams_setup.consent.create')}
                </button>
            )}

            {create.isError && (
                <p role="alert" className="mt-2 text-[12px] text-[var(--error-ink)]">{messageOf(create.error, t('teams_setup.consent.unavailable'))}</p>
            )}

            {link && !link.available && (
                <div role="alert" className="mt-3 rounded-lg border px-3 py-2.5 text-[12px] border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,var(--bg-secondary))]">
                    <p className="font-medium text-[var(--warning-ink)]">{t('teams_setup.consent.unavailable')}</p>
                    <p className="text-[var(--text-primary)]">{codeText(t, link.reason, {})}</p>
                    {fixText(t, REASON_FIX[link.reason]) && <p className="mt-1 text-[var(--text-secondary)]">{fixText(t, REASON_FIX[link.reason])}</p>}
                    {/* Every reason is the platform administrator's (the org.consent_link check says the same). */}
                    <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                        <span className="font-medium">{t('teams_setup.ui.who_fixes')}:</span> {fixerText(t, 'platform_admin')}
                    </p>
                </div>
            )}

            {link?.available && (
                <div className="mt-3 flex flex-col gap-2">
                    <input
                        type="text" readOnly value={link.url} aria-label={t('teams_setup.consent.title')}
                        onFocus={(e) => e.currentTarget.select()}
                        className="w-full px-3 py-1.5 rounded-lg border font-mono text-[11px] border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                        <a href={link.url} target="_blank" rel="noopener noreferrer" className={BUTTON}>
                            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />{t('teams_setup.consent.open')}
                        </a>
                        <button type="button" onClick={() => { void copy(link.url); }} className={BUTTON}>
                            <Copy className="w-3.5 h-3.5" aria-hidden="true" />{copied ? t('teams_setup.consent.copied') : t('teams_setup.consent.copy')}
                        </button>
                    </div>
                    {Number.isFinite(expiresMs) && (
                        <p className="text-[11px] text-[var(--text-muted)]">{t('teams_setup.consent.expires', { time: new Date(expiresMs).toLocaleTimeString() })}</p>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * DSR → "Public form" tab: the facts about the intake form a data subject
 * reaches without an account — its URL (copyable), the rate limit, the
 * identity link in the acknowledgement e-mail. Read-only; the DPO contact
 * and auto-acknowledge live in the settings section.
 */
import React, { useState } from 'react';
import { ArrowUpRight, BadgeCheck, Check, Copy, Globe, Settings2, ShieldCheck, Timer } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';

/** The public route App.jsx mounts before any auth handling. */
export const PUBLIC_DSR_PATH = '/privacy/requests';

/** `settings.public_dsr_url` when the org has one, else this origin + the public path. */
export function publicDsrUrl(settings, origin) {
    const own = settings?.public_dsr_url || settings?.dsr_public_url;
    if (own && typeof own === 'string') return own;
    const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
    return `${base}${PUBLIC_DSR_PATH}`;
}

const CARD = 'rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 flex flex-col gap-3';
const SECONDARY = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)]';

async function copyText(text) {
    try {
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through */ }
    return false;
}

export default function PublicFormTab({ publicUrl, onOpenSettings, onCopied, testId = 'dsr-public-form' }) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const url = publicUrl || publicDsrUrl(null);

    const copy = async () => {
        const ok = await copyText(url);
        setCopied(ok);
        onCopied?.(ok);
        if (ok) setTimeout(() => setCopied(false), 1500);
    };

    return (
        <div className="flex flex-col gap-3 max-w-[720px]" data-testid={testId}>
            <div className={CARD}>
                <div className="flex items-center gap-2">
                    <Globe size={14} aria-hidden="true" style={{ color: 'var(--kind-compliance)' }} />
                    <span className="font-semibold text-[13px]">{t('compliance.dsr_pf_title', 'Public request form')}</span>
                </div>
                <p className="m-0 text-[12px] text-[var(--text-secondary)] leading-5">
                    {t('compliance.dsr_pf_intro', 'Data subjects submit requests here without an account. Link it from your privacy notice; every submission starts the one-month clock at receipt.')}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                    <code className="font-mono text-[12px] px-2.5 py-1.5 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-primary)] truncate max-w-full" data-testid={`${testId}-url`}>{url}</code>
                    <button type="button" onClick={copy} className={SECONDARY} data-testid={`${testId}-copy`} aria-live="polite">
                        {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                        {copied ? t('common.copied', 'Copied to clipboard') : t('common.copy', 'Copy')}
                    </button>
                    <a href={url} target="_blank" rel="noopener noreferrer" className={SECONDARY} data-testid={`${testId}-open`}>
                        {t('compliance.dsr_view_form', 'View form')}<ArrowUpRight size={12} aria-hidden="true" />
                    </a>
                </div>
            </div>

            <div className={CARD}>
                <dl className="m-0 grid grid-cols-[18px_1fr] gap-x-2.5 gap-y-3 text-[12px]">
                    <Timer size={14} aria-hidden="true" className="text-[var(--text-tertiary)] mt-0.5" />
                    <div>
                        <dt className="font-medium">{t('compliance.dsr_pf_rate_title', 'Rate-limited')}</dt>
                        <dd className="m-0 text-[var(--text-secondary)]">{t('compliance.dsr_pf_rate_body', 'Five submissions per hour per IP address; the status check is limited too. The organisation is resolved from the e-mail address, so the form needs no login.')}</dd>
                    </div>
                    <BadgeCheck size={14} aria-hidden="true" className="text-[var(--text-tertiary)] mt-0.5" />
                    <div>
                        <dt className="font-medium">{t('compliance.dsr_pf_identity_title', 'Identity via e-mail link')}</dt>
                        <dd className="m-0 text-[var(--text-secondary)]">{t('compliance.dsr_pf_identity_body', 'The acknowledgement e-mail carries a single-use link (valid 7 days). Clicking it marks the request "identity confirmed" — nothing is sent to the address before that.')}</dd>
                    </div>
                    <ShieldCheck size={14} aria-hidden="true" className="mt-0.5" style={{ color: 'var(--kind-compliance)' }} />
                    <div>
                        <dt className="font-medium">{t('compliance.dsr_pf_privacy_title', 'What the form stores')}</dt>
                        <dd className="m-0 text-[var(--text-secondary)]">{t('compliance.dsr_pf_privacy_body', 'E-mail address, kind of request and the free-text note. The register shows the address masked; the full address is visible only to the DPO and the handler.')}</dd>
                    </div>
                </dl>
            </div>

            {onOpenSettings && (
                <button type="button" onClick={onOpenSettings} className={`${SECONDARY} self-start`} data-testid={`${testId}-settings`}>
                    <Settings2 size={12} aria-hidden="true" />{t('compliance.dsr_pf_settings_link', 'DPO contact and acknowledgement e-mail → Settings')}
                </button>
            )}
        </div>
    );
}

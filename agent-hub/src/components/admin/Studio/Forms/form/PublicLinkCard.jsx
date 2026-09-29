import { Check, ExternalLink, Link2, Loader2, RefreshCw } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DashCard from '../../../../shared/dashboard/DashCard';
import useConfirm from '../../../../shared/useConfirm';
import { publicFormPath } from '../FormsStudio';

const BTN = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50';

/**
 * The form's address: copy it, open it, or mint a new one (the old link
 * stops working at once — the token IS the credential).
 *
 * The builder's FormTriggerUrlPanel does the same on the builder's own
 * confirm and colour classes; this one is on tokens and shared/useConfirm.
 */
export default function PublicLinkCard({ form, canEdit, onChanged = null }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const { confirm, confirmDialog } = useConfirm();
    const [copied, setCopied] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const path = publicFormPath(form);
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const href = path ? `${origin}${path}` : null;

    useEffect(() => { setError(null); }, [form?.id]);

    const copy = useCallback(async () => {
        if (!href) return;
        try {
            await navigator.clipboard.writeText(href);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            setError(t('forms.studio.copy_failed', 'Could not copy the link — your browser refused clipboard access.'));
        }
    }, [href, t]);

    const rotate = useCallback(async () => {
        const ok = await confirm({
            title: t('forms.share.link_rotate_title', 'Create a new link?'),
            description: t('forms.share.link_rotate_body', 'The current link stops working immediately — anyone who already has it will see “not available”.'),
            confirmLabel: t('forms.share.link_rotate_confirm', 'Create a new link'),
            cancelLabel: t('forms.new.cancel', 'Cancel'),
            destructive: true,
        });
        if (!ok) return;
        setBusy(true);
        setError(null);
        try {
            await api.rotateFormPage(form.automationId, form.id);
            if (onChanged) await onChanged();
        } catch (e) {
            setError(e?.message || t('forms.page.save_failed', 'Could not save the form.'));
        } finally {
            setBusy(false);
        }
    }, [api, confirm, form, onChanged, t]);

    return (
        <DashCard title={t('forms.share.link_title', 'Link to the form')} testId="form-link-card">
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {form?.audience?.mode === 'restricted'
                    ? t('forms.share.link_blurb_restricted', 'Only the people and groups listed under “Who can fill it in” can open this link, after signing in. It only works while the form is live.')
                    : t('forms.share.link_blurb', 'Colleagues in your organisation can open this link after signing in. It only works while the form is live.')}
            </p>
            {href ? (
                <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs px-2 py-1.5 rounded-lg truncate max-w-full" style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} data-testid="form-link" aria-label={t('forms.share.link_label', 'Form address')}>
                        {href}
                    </code>
                    <button type="button" onClick={copy} className={BTN} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} data-testid="form-link-copy">
                        {copied ? <Check className="w-3 h-3" style={{ color: 'var(--success)' }} aria-hidden="true" /> : <Link2 className="w-3 h-3" aria-hidden="true" />}
                        {copied ? t('forms.studio.copied', 'Link copied') : t('forms.studio.copy_link', 'Copy the link')}
                    </button>
                    <a href={href} target="_blank" rel="noopener noreferrer" className={BTN} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} data-testid="form-link-open">
                        <ExternalLink className="w-3 h-3" aria-hidden="true" />
                        {t('forms.page.open_new_tab', 'Open in a new tab')}
                    </a>
                    {canEdit && (
                        <button type="button" onClick={rotate} disabled={busy} className={BTN} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} data-testid="form-link-rotate">
                            {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3 h-3" aria-hidden="true" />}
                            {t('forms.share.link_rotate', 'New link')}
                        </button>
                    )}
                </div>
            ) : (
                <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('forms.share.link_generating', 'The link is being created — save the form once and it appears here.')}</p>
            )}
            {error && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error}</p>}
            {confirmDialog}
        </DashCard>
    );
}

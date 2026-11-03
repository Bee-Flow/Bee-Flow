import { useState } from 'react';
import { FlaskConical, UserCheck } from 'lucide-react';
import useTranslation from '../hooks/useTranslation';

/**
 * What the hosted form page (PublicFormPage) says besides the form itself:
 *
 *   TestLinkBanner   the page was opened through a form's TEST LINK: the
 *                    questions as they are saved now, and every submission is
 *                    a test run (real effects, no answers row)
 *   FormNotLiveView  the caller may edit this form, and it is not live yet
 *                    (409 form_not_live): say so instead of "not available",
 *                    and point at the two ways forward
 *   FormWaitingDecisionView  the journey waits on a person's decision (an
 *                    approval): no spinner, no "taking a while", the visitor may
 *                    close the page; the address that brings them back (the
 *                    session is in ?s=), and "Check again"
 */

export function TestLinkBanner() {
    const { t } = useTranslation();
    return (
        <div role="note" data-testid="form-test-banner" className="mb-4 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs border-[var(--warning)] text-[var(--text-primary)] bg-[var(--bg-secondary)]">
            <FlaskConical size={14} className="mt-0.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
            <span>
                <strong className="font-semibold">{t('forms.public_test_title', 'Test')}</strong>
                {' · '}
                {t('forms.public_test_text', 'You opened a test link. This is the form as it is saved now; sending it starts a test run, with real effects, and nothing lands in the answers.')}
            </span>
        </div>
    );
}

interface FormNotLiveViewProps {
    automationId: string | null;
}

export function FormNotLiveView({ automationId }: FormNotLiveViewProps) {
    const { t } = useTranslation();
    return (
        <div className="text-center py-24" data-testid="form-not-live">
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">{t('forms.public_not_live_title', 'This form is not live yet')}</h1>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {t('forms.public_not_live_text', 'Only you see this, because you can edit it. Activate the automation to open the form to others, or try it first from the builder or with a test link (Forms → Share).')}
            </p>
            {automationId && (
                <a href={`/app/studio/automations/${encodeURIComponent(automationId)}`} className="mt-4 inline-block px-3 py-1.5 text-sm rounded-md border border-[var(--border-default)] text-[var(--text-primary)]">
                    {t('forms.studio.open_automation', 'Open the automation')}
                </a>
            )}
        </div>
    );
}

interface FormWaitingDecisionViewProps {
    /** The visitor will be sent the link when the next page is ready. */
    notify: boolean;
    onCheckAgain: () => void;
}

export function FormWaitingDecisionView({ notify, onCheckAgain }: FormWaitingDecisionViewProps) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    // The address this page is on carries the session (?s=): it is the way back.
    const link = typeof window === 'undefined' ? '' : window.location.href;
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(link);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    };
    return (
        <div className="text-center py-16" data-testid="form-waiting-decision" role="status">
            <UserCheck size={28} className="mx-auto text-[var(--text-secondary)]" aria-hidden="true" />
            <h1 className="mt-3 text-lg font-semibold text-[var(--text-primary)]">{t('forms.public_waiting_decision_title', 'Waiting for a review')}</h1>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {notify
                    ? t('forms.public_waiting_decision_text', 'A person needs to review this. You can close this page; we will send you a link when the next page is ready.')
                    : t('forms.public_waiting_decision_text_no_notify', 'A person needs to review this. You can close this page and come back to it later with the link below.')}
            </p>
            <p className="mt-4 text-xs text-[var(--text-secondary)]">{t('forms.public_waiting_decision_link', 'This page, to come back to:')}</p>
            <p className="mt-1 break-all text-xs font-mono text-[var(--text-primary)]" data-testid="form-resume-link">{link}</p>
            <div className="mt-4 flex items-center justify-center gap-2">
                <button
                    type="button"
                    onClick={copy}
                    className="px-3 py-1.5 text-sm rounded-md border border-[var(--border-default)] text-[var(--text-primary)]"
                >
                    {copied ? t('forms.public_link_copied', 'Link copied') : t('forms.public_copy_link', 'Copy link')}
                </button>
                <button
                    type="button"
                    onClick={onCheckAgain}
                    className="px-3 py-1.5 text-sm rounded-md border border-[var(--border-default)] text-[var(--text-primary)]"
                >
                    {t('forms.public_check_again', 'Check again')}
                </button>
            </div>
        </div>
    );
}

import { FlaskConical } from 'lucide-react';
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

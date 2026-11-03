import { Check, ExternalLink, FlaskConical, Link2, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import FormAudienceCard from './FormAudienceCard';
import useTestLinkActions from './useTestLinkActions';
import type { FormDetail } from './useFormDetail';
import { formTestLinkApi, type FormTestLink, type FormTestLinkApi } from '@/api/formTestLink';
import { useTranslation } from '@/hooks/useTranslation';
import DashCard from '@/components/shared/dashboard/DashCard';

const BTN = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50 border-[var(--border-subtle)] text-[var(--text-secondary)]';

/**
 * The form's TEST LINK (D3): a separate address that opens the questions as
 * they are saved now (the working copy), for the people chosen here, whether
 * or not the form is live. Every submission through it is a test run: its
 * effects are real (mail goes out, rows are written), its approvals go to the
 * person who filled it in, and nothing lands in the answers or the counts.
 *
 * Make one (the maker's alone, it expires after a while), choose who may open
 * it, copy or open it, make a new one (the old one stops working) or stop it.
 * Only for someone who may edit the automation (the form detail carries its
 * definition); `api` is injectable for a test.
 */
interface TestLinkCardProps {
    form: FormDetail;
    canEdit: boolean;
    onChanged?: (() => Promise<unknown> | void) | null;
    api?: FormTestLinkApi;
}

export default function TestLinkCard({ form, canEdit, onChanged = null, api = formTestLinkApi }: TestLinkCardProps) {
    const { t } = useTranslation();
    const link = form.testLink || null;
    const href = link ? `${typeof window !== 'undefined' ? window.location.origin : ''}${link.url}` : null;
    const actions = useTestLinkActions({ automationId: form.automationId, hasLink: !!link, href, api, onChanged });
    if (!form.definition && !link) return null;

    return (
        <DashCard title={t('forms.test_link.title', 'Test link')} testId="form-test-link">
            <p className="text-xs text-[var(--text-secondary)]">
                {form.live === false && `${t('forms.share.link_not_live', 'The form is not live yet, so its link opens nothing for now. To try it first, use a test link.')} `}
                {t('forms.test_link.blurb', 'A separate address to try the form as a visitor would, before it is live: it opens the questions as they are saved now. Every submission is a test run with real effects (mail is sent, rows are written); approvals go to whoever filled it in, and nothing lands in the answers.')}
            </p>
            {link && href ? (
                <>
                    <TestLinkRow link={link} href={href} canEdit={canEdit} actions={actions} />
                    <FormAudienceCard
                        key={link.token}
                        form={{ ...form, audience: link.audience }}
                        canEdit={canEdit && !actions.busy}
                        title={t('forms.test_link.audience_title', 'Who can open the test link')}
                        testId="form-test-link-audience"
                        save={async (body) => ({ audience: (await api.setAudience(form.automationId, body)).testLink.audience })}
                    />
                </>
            ) : canEdit && (
                <button type="button" onClick={actions.create} disabled={actions.busy} className={BTN} data-testid="form-test-link-create">
                    {actions.busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <FlaskConical className="w-3 h-3" aria-hidden="true" />}
                    {t('forms.test_link.create', 'Make a test link')}
                </button>
            )}
            {actions.error && <p role="alert" className="text-xs text-[var(--error)]">{actions.error}</p>}
            {actions.confirmDialog}
        </DashCard>
    );
}

interface TestLinkRowProps {
    link: FormTestLink;
    href: string;
    canEdit: boolean;
    actions: ReturnType<typeof useTestLinkActions>;
}

/** The address, copy, open, a new link, stop; and until when it works. */
function TestLinkRow({ link, href, canEdit, actions }: TestLinkRowProps) {
    const { t } = useTranslation();
    const expiry = link.expiresAt
        ? t('forms.test_link.expires', 'Works until {date}.', { date: new Date(link.expiresAt).toLocaleDateString() })
        : t('forms.test_link.no_expiry', 'Does not expire.');
    return (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs px-2 py-1.5 rounded-lg truncate max-w-full bg-[var(--bg-secondary)] text-[var(--text-primary)]" data-testid="form-test-link-url" aria-label={t('forms.test_link.label', 'Test link address')}>
                    {href}
                </code>
                <button type="button" onClick={actions.copy} className={BTN} data-testid="form-test-link-copy">
                    {actions.copied ? <Check className="w-3 h-3 [color:var(--success)]" aria-hidden="true" /> : <Link2 className="w-3 h-3" aria-hidden="true" />}
                    {actions.copied ? t('forms.studio.copied', 'Link copied') : t('forms.studio.copy_link', 'Copy the link')}
                </button>
                <a href={href} target="_blank" rel="noopener noreferrer" className={BTN} data-testid="form-test-link-open">
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />{t('forms.page.open_form', 'Open the form')}
                </a>
                {canEdit && (
                    <>
                        <button type="button" onClick={actions.create} disabled={actions.busy} className={BTN} data-testid="form-test-link-renew">
                            <RefreshCw className="w-3 h-3" aria-hidden="true" />{t('forms.share.link_rotate', 'New link')}
                        </button>
                        <button type="button" onClick={actions.revoke} disabled={actions.busy} className={BTN} data-testid="form-test-link-revoke">
                            <Trash2 className="w-3 h-3" aria-hidden="true" />{t('forms.test_link.revoke', 'Stop the test link')}
                        </button>
                    </>
                )}
            </div>
            <p className="text-[11px] text-[var(--text-tertiary)]" data-testid="form-test-link-expiry">{expiry}</p>
        </>
    );
}

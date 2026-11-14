import { useId, useState } from 'react';
import { usePolicyBodyQuery, usePublishedPoliciesQuery } from '../../api/queries/complianceReads';
import { FileText, Check, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import { ApiError } from '../../api/mutate';
import { ALERT_ERROR } from '../../components/mcpLibrary/ui';
import { apiRequest } from '@/api/typedRequest';

/** The body of the open policy while it is not there: on its way, or failed with a way to ask again. */
function PolicyBodyPending({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
    const { t } = useTranslation();
    if (!failed) return <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />;
    return (
        <div role="alert" className={`${ALERT_ERROR} items-center justify-between`}>
            <span>{t('settings.policy_ack_load_failed', 'Could not load this policy.')}</span>
            <button type="button" onClick={onRetry} className="shrink-0 font-semibold underline">{t('error.try_again', 'Try again')}</button>
        </div>
    );
}

/**
 * The confirm button of the open policy. A policy can only be confirmed once
 * its text is on screen: while the text loads the button is disabled and says
 * why; when the text could not be loaded the caller leaves it out entirely and
 * only "Try again" is offered.
 */
function ConfirmPolicy({ bodyLoaded, busy, onConfirm }: { bodyLoaded: boolean; busy: boolean; onConfirm: () => void }) {
    const { t } = useTranslation();
    const hintId = useId();
    return (
        <div className="space-y-1">
            <button type="button" onClick={onConfirm} disabled={busy || !bodyLoaded}
                aria-describedby={bodyLoaded ? undefined : hintId}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white disabled:opacity-50 bg-[var(--accent-primary)]">
                <Check className="w-3.5 h-3.5" /> {t('settings.policy_ack_confirm')}
            </button>
            {!bodyLoaded && (
                <p id={hintId} className="text-[11px] text-[var(--text-muted)]">
                    {t('settings.policy_ack_confirm_wait', 'You can confirm once the policy text has loaded.')}
                </p>
            )}
        </div>
    );
}

/**
 * Member-facing ISMS policy acknowledgements (ISO 27001 clause 7.3 awareness).
 *
 * Lists the org's published policies with this user's acknowledgement state;
 * reading expands the markdown body inline, confirming binds the user to the
 * exact published version (sha256'd server-side). Confirming is only offered
 * once that body has loaded: nobody confirms a policy they could not read. Renders nothing when the org
 * has no published policies or the compliance module isn't licensed — this is
 * an Enterprise surface that must not clutter everyone else's settings.
 */
export default function PolicyAcknowledgements() {
    const { t } = useTranslation();
    type PolicyDoc = { slug: string; title: string; current_version: number; acknowledged?: boolean | string; acknowledged_at: string | null };
    const policies = usePublishedPoliciesQuery<PolicyDoc>();
    // 402/403 (unlicensed or no access) reads as none, so the card stays invisible.
    const docs: PolicyDoc[] | null = policies.isPending ? null : (policies.data ?? []);
    const [openSlug, setOpenSlug] = useState<string | null>(null);
    const bodyQuery = usePolicyBodyQuery(openSlug);
    const body = bodyQuery.data ?? null;
    // The read answered (or was refused) without a text: say so and offer
    // another try. It used to leave the spinner turning for good.
    const bodyFailed = !body && !bodyQuery.isFetching;
    const [busySlug, setBusySlug] = useState<string | null>(null);
    const { refetch: refresh } = policies;

    if (!docs || docs.length === 0) return null;

    const open = (slug: string) => { setOpenSlug(openSlug === slug ? null : slug); };

    const confirm = async (slug: string) => {
        setBusySlug(slug);
        try {
            const r = await apiRequest('POST /api/compliance/iso/docs/{slug}/acknowledge', { params: { slug }, init: { headers: { 'Content-Type': 'application/json' }, body: '{}' } }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (r) await refresh();
        } finally { setBusySlug(null); }
    };

    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-5 space-y-3">
            <div className="flex items-center gap-2">
                <FileText className="w-5 h-5 text-[var(--accent-primary)]" />
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('settings.policy_ack_title')}</h3>
            </div>
            <p className="text-xs text-[var(--text-muted)]">{t('settings.policy_ack_desc')}</p>
            <div className="space-y-2">
                {docs.map(d => (
                    <div key={d.slug} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)]">
                        <button onClick={() => open(d.slug)}
                            className="w-full flex items-center gap-2 px-3 py-2.5 text-left">
                            {openSlug === d.slug
                                ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                                : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />}
                            <span className="flex-1 text-[13px] font-medium text-[var(--text-primary)]">
                                {d.title} <span className="text-[var(--text-muted)] font-normal">v{d.current_version}</span>
                            </span>
                            {d.acknowledged ? (
                                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-green-600">
                                    <Check className="w-3.5 h-3.5" />
                                    {t('settings.policy_ack_done', { date: d.acknowledged_at ? new Date(d.acknowledged_at).toLocaleDateString() : '' }, null) || 'Confirmed'}
                                </span>
                            ) : (
                                <span className="text-[11px] font-semibold text-amber-500">{t('settings.policy_ack_read')}</span>
                            )}
                        </button>
                        {openSlug === d.slug && (
                            <div className="px-4 pb-3 space-y-3">
                                {body === null ? (
                                    <PolicyBodyPending failed={bodyFailed} onRetry={() => { void bodyQuery.refetch(); }} />
                                ) : (
                                    <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed text-[var(--text-secondary)] max-h-80 overflow-y-auto rounded-lg bg-[var(--bg-secondary)] p-3">
                                        {body.body}
                                    </pre>
                                )}
                                {!d.acknowledged && !bodyFailed && (
                                    <ConfirmPolicy
                                        bodyLoaded={body !== null}
                                        busy={busySlug === d.slug}
                                        onConfirm={() => { void confirm(d.slug); }}
                                    />
                                )}
                            </div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

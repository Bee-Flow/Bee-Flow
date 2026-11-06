import { useState } from 'react';
import { Download, Eye, Trash2 } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { toast } from '@/components/shared/Toast';
import { useKbQuerySubjectQuery } from '@/api/queries/complianceReads';
import { useKbQuerySubjectActions, type KqlRefusal } from '../../data/useKbQuerySubjectActions';
import type { KqlContent } from '@/api/kbQueryLog.types';
import type { DsrRequestRow } from '../../data/aggregates';
import type { OrgUser } from '../accessAuditLabels';
import { ActionButton, Fact, Field, Intro, PAGE_FRAME, ReadFailed, Select, TextArea, UserSelect, fmtStamp, labelOf, type SelectOption } from '../audits/auditForms';
import { KQL_CHANNEL, KQL_OUTCOME } from './labels';

const OPEN = new Set(['pending', 'in_progress']);

type DsrChoice = DsrRequestRow & { subject_email_masked?: string | null };

interface RequestsTabProps {
    orgUsers?: OrgUser[] | null;
    dsrRequests?: DsrChoice[] | null;
    exportsEnabled?: boolean;
}

function ContentList({ content }: { content: KqlContent }) {
    const { t, resolvedLocale } = useTranslation();
    return (
                <div className="flex flex-col gap-2" data-testid="kql-content">
                    <span className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.kql_content_count', '{n} entries', { n: content.total })}</span>
                    {content.rows.map((r) => (
                        <article key={r.id} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-3 flex flex-col gap-1.5" data-testid={`kql-content-${r.id}`}>
                            <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">
                                {fmtStamp(r.createdAt, resolvedLocale)} · {r.kbName || '—'} · {labelOf(t, KQL_CHANNEL, r.channel)} · {labelOf(t, KQL_OUTCOME, r.outcome)}
                            </span>
                            <Fact label={t('compliance.kql_asked', 'Asked')}><span className="whitespace-pre-wrap">{r.query || '—'}</span></Fact>
                            <Fact label={t('compliance.kql_answered', 'Answer')}><span className="whitespace-pre-wrap">{r.answer || '—'}</span></Fact>
                            {r.chunks.length > 0 && <Fact label={t('compliance.kql_passages', 'Passages')}>{r.chunks.map((c) => c.title || c.sourceUri).filter(Boolean).join(' | ') || '—'}</Fact>}
                        </article>
                    ))}
                </div>

    );
}

function SubjectCard({ userId, orgUsers, onPick }: { userId: string; orgUsers: OrgUser[] | null; onPick: (v: string) => void }) {
    const { t } = useTranslation();
    const subject = useKbQuerySubjectQuery(userId || null);
    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-3 flex flex-wrap items-end gap-3">
            <Field label={t('compliance.kql_col_person', 'Person')} className="w-[240px]">
                <UserSelect value={userId} orgUsers={orgUsers} noneLabel={t('compliance.kql_pick_person', 'Choose a person')} onChange={onPick} data-testid="kql-subject-user" />
            </Field>
            {userId && subject.data && (
                <div className="text-xs text-[var(--text-secondary)]" data-testid="kql-subject-counts">
                    <b className="tabular-nums text-[var(--text-primary)]">{subject.data.total}</b> {t('compliance.kql_subject_total', 'logged searches')}
                    {subject.data.byKb.map((b) => <div key={b.kbId} className="tabular-nums">{b.kbName || b.kbId}: {b.count}</div>)}
                </div>
            )}
            {userId && subject.isError && <ReadFailed testId="kql-subject-failed">{t('compliance.kql_read_failed_subject', 'The counts for this person could not be read.')}</ReadFailed>}
        </div>
    );
}

function RefusalNotice({ refused }: { refused: KqlRefusal | null }) {
    const { t } = useTranslation();
    if (refused === 'dsr_request_required') {
        return (
            <ReadFailed testId="kql-dsr-required">
                {t('compliance.kql_dsr_required', 'This needs an open data-subject request of this organisation about this person. Choose a request that is still open and is about them.')}
            </ReadFailed>
        );
    }
    if (refused === 'failed') return <ReadFailed testId="kql-action-failed">{t('compliance.kql_action_failed', 'That did not work. Nothing was changed.')}</ReadFailed>;
    return null;
}

/**
 * Data-subject requests: counts for one person are free to see; their text is
 * opened, exported or erased only against an open request. The server checks
 * the request again and answers 403 `dsr_request_required` when it does not fit.
 */
export default function RequestsTab({ orgUsers = null, dsrRequests = null, exportsEnabled = true }: RequestsTabProps) {
    const { t, resolvedLocale } = useTranslation();
    const [userId, setUserId] = useState('');
    const [dsrId, setDsrId] = useState('');
    const [reason, setReason] = useState('');
    const [confirming, setConfirming] = useState(false);
    const { content, download, erase, refused, reset } = useKbQuerySubjectActions();

    const open = (dsrRequests ?? []).filter((r) => OPEN.has(r.status));
    const requestOptions: SelectOption[] = [
        { value: '', label: t('compliance.kql_dsr_none', 'Choose an open request') },
        ...open.map((r) => ({ value: String(r.id), label: `#${r.id} · ${r.request_type || t('compliance.kql_dsr_request', 'request')}${r.subject_email_masked ? ` · ${r.subject_email_masked}` : ''}` })),
    ];
    const ready = !!userId && !!dsrId;
    const target = { userId, dsrRequestId: dsrId };
    const busy = content.isPending || download.isPending || erase.isPending;
    const pick = (setter: (v: string) => void) => (v: string) => { setter(v); reset(); };

    const doErase = async () => {
        // A refusal is shown by the notice below (`refused`); the dialog closes either way.
        const done = await erase.mutateAsync({ ...target, reason: reason.trim() }).then((r) => r, () => null);
        setConfirming(false);
        if (!done) return;
        toast.success(t('compliance.kql_erased', '{n} entries erased', { n: done.deleted }));
        setReason('');
    };
    const doExport = (format: 'json' | 'csv') => { download.mutate({ ...target, format }); };

    return (
        <div className={`h-full min-h-0 overflow-y-auto ${PAGE_FRAME}`} data-testid="kql-requests">
            <Intro testId="kql-requests-intro">
                {t('compliance.kql_requests_intro', 'Pick a person to see how many logged searches they have. To read, export or erase the text, pick the open data-subject request it is for.')}
            </Intro>
            <SubjectCard userId={userId} orgUsers={orgUsers} onPick={pick(setUserId)} />

            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-3 flex flex-col gap-3" data-testid="kql-content-card">
                <p className="m-0 text-[var(--text-secondary)]" data-testid="kql-logged-notice">
                    {t('compliance.kql_viewing_logged', 'Reading, exporting or erasing the text is itself recorded in the access log, with the request number.')}
                </p>
                <Field label={t('compliance.kql_dsr_label', 'Open data-subject request')} className="max-w-[420px]">
                    <Select value={dsrId} options={requestOptions} onChange={pick(setDsrId)} data-testid="kql-dsr-select" />
                </Field>
                <Field label={t('compliance.kql_reason_label', 'Reason for erasing (required to erase)')} className="max-w-[420px]">
                    <TextArea value={reason} onChange={setReason} maxLength={1000} data-testid="kql-reason" />
                </Field>
                <div className="flex flex-wrap gap-2">
                    <ActionButton icon={Eye} disabled={!ready || busy} onClick={() => content.mutate(target)} data-testid="kql-view-content">
                        {t('compliance.kql_view_content', 'Show content')}
                    </ActionButton>
                    {exportsEnabled && (
                        <>
                            <ActionButton icon={Download} disabled={!ready || busy} onClick={() => doExport('json')} data-testid="kql-export-json">{t('compliance.kql_export_json', 'Export (JSON)')}</ActionButton>
                            <ActionButton icon={Download} disabled={!ready || busy} onClick={() => doExport('csv')} data-testid="kql-export-csv">{t('compliance.kql_export_csv_short', 'Export (CSV)')}</ActionButton>
                        </>
                    )}
                    <ActionButton variant="error" icon={Trash2} disabled={!ready || busy || !reason.trim()} onClick={() => setConfirming(true)} data-testid="kql-erase">
                        {t('compliance.kql_erase', 'Erase entries')}
                    </ActionButton>
                </div>
                <RefusalNotice refused={refused} />
            </div>

            {content.data && <ContentList content={content.data} />}

            <ConfirmDialog
                open={confirming}
                destructive
                title={t('compliance.kql_erase_title', 'Erase these entries?')}
                description={t('compliance.kql_erase_body', 'All logged searches of this person, with what they asked and were answered, are erased for good. This cannot be undone. The erasure and your reason are recorded in the access log.')}
                confirmLabel={t('compliance.kql_erase_confirm', 'Erase for good')}
                cancelLabel={t('compliance.kql_erase_cancel', 'Cancel')}
                onConfirm={doErase}
                onCancel={() => setConfirming(false)}
            />
        </div>
    );
}

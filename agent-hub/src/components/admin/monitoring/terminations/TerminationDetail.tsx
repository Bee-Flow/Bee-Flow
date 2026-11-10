import { FileWarning } from 'lucide-react';
import { ALERT_WARNING } from '@/components/mcpLibrary/ui';
import { LARGE_ATTACHMENT_BYTES_THRESHOLD, LARGE_INPUT_TOKEN_THRESHOLD, isLargeInput } from '@/utils/terminationsModel';
import { useTranslation } from '@/hooks/useTranslation';
import { fmt } from '../shared';
import { fmtBytes } from '../TerminationsPage.helpers';
import type { DetailRowProps, TerminationRow } from '../TerminationsPage.types';

function DetailRow({ label, value, mono }: DetailRowProps) {
    return (
        <div className="flex items-baseline gap-3">
            <span className="min-w-[110px] text-[10px] font-semibold uppercase tracking-[0.04em] text-[var(--text-tertiary)]">{label}</span>
            <span className={`flex-1 break-all ${mono ? 'font-mono' : ''} ${value ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}>
                {value || '—'}
            </span>
        </div>
    );
}

/** Why a large input is the likely cause: the attachment, the prompt, or both. */
function LargeInputHint({ r }: { r: TerminationRow }) {
    const { t } = useTranslation();
    return (
        <div className={`${ALERT_WARNING} mt-1.5`}>
            <FileWarning className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
            <span>
                <strong>{t('admin_monitoring.term_likely_large', 'Likely caused by large input.')}</strong>{' '}
                {r.attachment_bytes >= LARGE_ATTACHMENT_BYTES_THRESHOLD
                    ? t('admin_monitoring.term_hint_attachment', 'An attachment of {size} was sent; ', { size: fmtBytes(r.attachment_bytes) })
                    : ''}
                {r.prompt_tokens >= LARGE_INPUT_TOKEN_THRESHOLD
                    ? t('admin_monitoring.term_hint_prompt', 'the prompt was {n} tokens; ', { n: fmt(r.prompt_tokens) })
                    : ''}
                {t('admin_monitoring.term_hint_smaller', 'Suggest a smaller context or split the upload.')}
            </span>
        </div>
    );
}

/** One termination opened: where it ran, the sanitised error, tokens and attachments. Messages are never logged. */
export function TerminationDetail({ r }: { r: TerminationRow }) {
    const { t } = useTranslation();
    const total = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    const ratio = total > 0 ? Math.round((r.prompt_tokens / total) * 100) : 0;
    const tokens = t('admin_monitoring.term_tokens_detail', 'prompt {prompt} · completion {completion} · total {total}', { prompt: fmt(r.prompt_tokens), completion: fmt(r.completion_tokens), total: fmt(r.total_tokens) })
        + (total > 0 ? ' ' + t('admin_monitoring.term_tokens_ratio', '(prompt {ratio}%)', { ratio }) : '');
    return (
        <div role="row" className="flex flex-col gap-1.5 border-b border-[var(--border-default)] bg-[var(--bg-secondary)] px-4 py-3 text-xs">
            <DetailRow label="Source" value={r.source} />
            <DetailRow label={t('admin_monitoring.term_d_conversation', 'Conversation')} value={r.conversation_id} mono />
            <DetailRow label={t('admin_monitoring.term_d_user', 'User')} value={r.person?.name ?? r.user_id} mono={!r.person} />
            <DetailRow label={t('admin_monitoring.term_d_org', 'Organization')} value={r.organization_id} mono />
            <DetailRow label={t('admin_monitoring.term_col_error_code', 'Error code')} value={r.error_code} mono />
            <DetailRow label={t('admin_monitoring.term_col_iter', 'Iter.')} value={String(r.iteration_count || 0)} />
            <DetailRow label={t('admin_monitoring.term_d_error_class', 'Error class')} value={r.error_class} />
            <DetailRow label={t('admin_monitoring.term_d_error', 'Error')} value={r.error_first_line} mono />
            <DetailRow label={t('admin_monitoring.term_d_stack', 'Stack')} value={r.stack_first_line} mono />
            <DetailRow label={t('admin_monitoring.col_tokens', 'Tokens')} value={tokens} />
            <DetailRow
                label={t('admin_monitoring.term_d_attachments', 'Attachments')}
                value={r.attachment_count > 0 ? t('admin_monitoring.term_files_detail', '{n} files · {size}', { n: r.attachment_count, size: fmtBytes(r.attachment_bytes || 0) }) : null}
            />
            {isLargeInput(r) && <LargeInputHint r={r} />}
            <div className="mt-1 text-[10px] italic text-[var(--text-tertiary)]">
                {t('admin_monitoring.term_privacy_note', 'Privacy: messages are not logged. Only sanitised metadata is visible here.')}
            </div>
        </div>
    );
}

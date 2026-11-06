import { FileWarning } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { isLargeInput } from '@/utils/terminationsModel';
import type { TerminationRow } from '@/pages/settings/OrgTerminationsPanel.types';
import { fNum, fmtBytes } from '../format';

function DetailRow({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
    return (
        <div className="flex items-baseline gap-3">
            <span className="min-w-[110px] text-[11px] uppercase tracking-[.04em] text-[var(--text-muted)]">{label}</span>
            <span className={`flex-1 break-all ${mono ? 'font-mono' : ''} ${value ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{value || '—'}</span>
        </div>
    );
}

function tokenSplit(r: TerminationRow): string {
    const tot = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
    const ratio = tot > 0 ? Math.round((r.prompt_tokens / tot) * 100) : 0;
    return `prompt ${fNum(r.prompt_tokens)} · completion ${fNum(r.completion_tokens)} · total ${fNum(r.total_tokens)}${tot > 0 ? ` (prompt ${ratio}%)` : ''}`;
}

export function TerminationDetail({ row: r, showTokens }: { row: TerminationRow; showTokens: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-1.5 text-xs text-[var(--text-muted)]">
            <DetailRow label={t('org.terminations_detail_source', 'Source')} value={r.source} />
            <DetailRow label={t('org.terminations_detail_conversation', 'Conversation')} value={r.conversation_id} mono />
            <DetailRow label={t('org.terminations_detail_user', 'User')} value={r.user_id} mono />
            <DetailRow label={t('org.terminations_detail_error_class', 'Error class')} value={r.error_class} />
            <DetailRow label={t('org.terminations_detail_error', 'Error')} value={r.error_first_line} mono />
            <DetailRow label={t('org.terminations_detail_stack', 'Stack')} value={r.stack_first_line} mono />
            {showTokens && <DetailRow label={t('org.terminations_detail_tokens', 'Tokens')} value={tokenSplit(r)} />}
            <DetailRow label={t('org.terminations_detail_attachments', 'Attachments')} value={r.attachment_count > 0 ? `${r.attachment_count} · ${fmtBytes(r.attachment_bytes || 0)}` : null} />
            {isLargeInput(r, showTokens) && (
                <div className="mt-1.5 flex items-start gap-1.5 rounded-lg border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-2.5 py-2 text-[11px] text-[var(--warning)]">
                    <FileWarning className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                    <span><strong>{t('org.terminations_large_input_strong', 'Likely caused by large input.')}</strong> {t('org.terminations_large_input_explain', 'Suggest a smaller context or split the upload.')}</span>
                </div>
            )}
        </div>
    );
}

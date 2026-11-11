import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';

/** One delivery as the server lists it on a webhook row: never a body. */
export interface WebhookDelivery {
    id: string;
    status: string;
    bodyBytes: number;
    bodyHash?: string | null;
    receivedAt?: string | null;
}

/** What became of a delivery, in words. A status this build does not know is shown as it is. */
function statusLabel(t: TranslateFn, status: string): string {
    switch (status) {
        case 'accepted': return t('automation_webhook_log.status.accepted', 'Accepted');
        case 'bad_signature': return t('automation_webhook_log.status.bad_signature', 'Signature not accepted');
        case 'stale_timestamp': return t('automation_webhook_log.status.stale_timestamp', 'Timestamp outside the window');
        case 'replay': return t('automation_webhook_log.status.replay', 'Nonce used before');
        case 'inactive': return t('automation_webhook_log.status.inactive', 'Automation not active');
        case 'trigger_not_live': return t('automation_webhook_log.status.trigger_not_live', 'Trigger not published yet');
        default: return status;
    }
}

/**
 * The newest deliveries of one webhook, folded away under the row: when each arrived, what
 * became of it and how large it was. The owner reads here why a sender was not accepted; the
 * sender itself is told only that it was not.
 */
export default function WebhookDeliveries({ deliveries }: { deliveries: WebhookDelivery[] }) {
    const { t } = useTranslation();
    return (
        <details className="text-[var(--text-secondary)]" data-testid="webhook-deliveries">
            <summary className="cursor-pointer select-none">
                {t('automation_webhook_log.title', 'Recent deliveries')} ({deliveries.length})
            </summary>
            {deliveries.length === 0 ? (
                <div className="mt-1 text-[var(--text-tertiary)]">{t('automation_webhook_log.empty', 'No deliveries yet.')}</div>
            ) : (
                <ul className="mt-1 flex flex-col gap-0.5">
                    {deliveries.map((d) => (
                        <li key={d.id} className="flex items-baseline gap-2 flex-wrap">
                            <span className="text-[var(--text-tertiary)] tabular-nums">{d.receivedAt ? new Date(d.receivedAt).toLocaleString() : ''}</span>
                            <span className={d.status === 'accepted' ? 'text-[var(--success)]' : 'text-[var(--text-primary)]'}>{statusLabel(t, d.status)}</span>
                            <span className="text-[var(--text-tertiary)]">{t('automation_webhook_log.size', '{bytes} bytes', { bytes: d.bodyBytes })}</span>
                            {d.bodyHash && <code className="font-mono text-[11px] text-[var(--text-tertiary)]" title={t('automation_webhook_log.hash_title', 'Start of the SHA-256 of the body')}>{d.bodyHash}</code>}
                        </li>
                    ))}
                </ul>
            )}
            <div className="mt-1 text-[var(--text-tertiary)]">{t('automation_webhook_log.note', 'The body of a delivery is never kept here: only its size and a fingerprint.')}</div>
        </details>
    );
}

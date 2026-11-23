/**
 * Run receipts on screen (server/usecases/coworkReceipts.mts): one quiet line in an opened run ("Receipt 41 · signed"),
 * and, under the item's Settings → Changes, whether the chain holds, with the whole chain as a download. A receipt
 * holds names and counts only; it is there for an audit, so it stays out of the way.
 */
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { receiptsUrl, useReceipts, useRunReceipt } from '../../api/coworkReceipts';
import { useTranslation } from '../../hooks/useTranslation';

/** "Receipt 41 · signed" in an opened run; nothing while the run has none yet. */
export function RunReceiptLine({ coworkId, runId, finished }: { coworkId: string; runId: string; finished: boolean }) {
    const { t } = useTranslation();
    const receipt = useRunReceipt(coworkId, runId, finished).data;
    if (!receipt || typeof receipt.seq !== 'number') return null;
    return (
        <p className="text-[11px] pb-2 text-[var(--text-tertiary)] inline-flex items-center gap-1" data-testid="cowork-run-receipt">
            <ShieldCheck aria-hidden="true" className="w-3 h-3" />
            {receipt.signed
                ? t('cowork_receipts.run_signed', 'Receipt {seq} · signed', { seq: receipt.seq })
                : t('cowork_receipts.run_unsigned', 'Receipt {seq} · not signed', { seq: receipt.seq })}
        </p>
    );
}

const PROBLEM: Record<string, [string, string]> = {
    gap: ['cowork_receipts.problem.gap', 'Receipt {seq} is missing from the chain.'],
    link: ['cowork_receipts.problem.link', 'Receipt {seq} does not follow the one before it.'],
    content: ['cowork_receipts.problem.content', 'Receipt {seq} was changed after it was issued.'],
    signature: ['cowork_receipts.problem.signature', 'Receipt {seq} does not carry a valid signature.'],
};

/** Whether the item's chain holds, for Settings → Changes. */
export function ReceiptChain({ coworkId }: { coworkId: string }) {
    const { t } = useTranslation();
    const view = useReceipts(coworkId).data;
    if (!view?.verdict || view.verdict.count === 0) return null;
    const { verdict, missingRuns } = view;
    const problem = verdict.problem ? PROBLEM[verdict.problem.kind] : null;
    const holds = verdict.ok && missingRuns === 0;
    const Icon = holds ? ShieldCheck : ShieldAlert;
    return (
        <div className="flex flex-col gap-1 text-[12px]" data-testid="cowork-receipt-chain">
            <span className={`inline-flex items-center gap-1.5 ${holds ? 'text-[var(--text-secondary)]' : 'text-[var(--warning-ink)]'}`}>
                <Icon aria-hidden="true" className="w-3.5 h-3.5" />
                {holds
                    ? t('cowork_receipts.holds', 'Every run has a receipt, and the chain of {count} holds.', { count: verdict.count })
                    : problem
                        ? t(problem[0], problem[1], { seq: verdict.problem?.seq ?? 0 })
                        : t('cowork_receipts.missing', '{count} finished runs have no receipt.', { count: missingRuns })}
            </span>
            {verdict.unsigned > 0 && <span className="text-[var(--text-tertiary)]">{t('cowork_receipts.unsigned', '{count} were issued without a signature.', { count: verdict.unsigned })}</span>}
            <a className="self-start text-[12px] font-medium text-[var(--accent)]" href={receiptsUrl(coworkId)} download={`cowork-receipts-${coworkId}.json`}>
                {t('cowork_receipts.download', 'Download the receipts')}
            </a>
        </div>
    );
}

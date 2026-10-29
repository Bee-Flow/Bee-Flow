import { AlertTriangle, Loader2, Zap } from 'lucide-react';
import { intervalLabel, planCurrencySymbol, useLicenseText } from './licenseShared';
import type { BillingPlan, ChangePreview } from './licenseShared';
import type { OrgSubscriptionState } from './useOrgSubscription';
import Modal from '@/components/shared/Modal';

const SECONDARY_BUTTON = 'px-3 py-1.5 rounded-lg text-[12px] font-semibold border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50';
const PANEL = 'w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-4';

function PreviewRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex justify-between"><span className="text-[var(--text-muted)]">{label}</span><span className="font-semibold text-[var(--text-primary)]">{value}</span></div>
    );
}

/** What the change costs today and from the next renewal on. */
function ChangeCostPreview({ target, preview }: { target: BillingPlan; preview: ChangePreview }) {
    const { t, fmtDate } = useLicenseText();
    const sym = planCurrencySymbol(preview.currency, 'EUR');
    const renewal = `${sym}${Number(preview.next_renewal_total || 0).toFixed(2)} / ${intervalLabel(t, target.billing_interval)}`;
    if (preview.direction === 'downgrade') {
        const date = preview.effective ? fmtDate(preview.effective) : t('org.period_end', 'the end of this period');
        return (
            <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-4 space-y-2 text-[13px]">
                <PreviewRow label={t('org.takes_effect', 'Takes effect')} value={date} />
                <PreviewRow label={t('org.charge_today', 'Charge today')} value={`${sym}0.00`} />
                <PreviewRow label={t('org.then', 'Then')} value={renewal} />
            </div>
        );
    }
    const charge = Number(preview.proration_amount || 0);
    return (
        <div className="rounded-xl bg-[var(--bg-secondary)] border border-[var(--border-subtle)] p-4 space-y-2 text-[13px]">
            <PreviewRow label={t('org.prorated_charge_today', 'Prorated charge today')} value={`${sym}${charge.toFixed(2)}`} />
            <PreviewRow label={t('org.then', 'Then')} value={renewal} />
            {preview.per_seat && (preview.seat_quantity ?? 0) > 0 && (
                <div className="flex justify-between text-[11px] pt-1 border-t border-[var(--border-subtle)]"><span className="text-[var(--text-muted)]">{preview.seat_quantity} {t('org.seats', 'seats')}</span><span className="text-[var(--text-muted)]">{t('org.billed_per_seat', 'billed per seat')}</span></div>
            )}
        </div>
    );
}

type ChangeDialogProps = Pick<OrgSubscriptionState, 'setChangeTarget' | 'setChangePreview' | 'changeBusy' | 'handleConfirmChange'> & {
    target: BillingPlan;
    preview: ChangePreview;
    labelId: string;
};

/**
 * Change-plan confirmation, through the shared Modal. Escape and the backdrop
 * close it, but not while its request is in flight.
 */
export function ChangePlanDialog({ target, preview, labelId, setChangeTarget, setChangePreview, changeBusy, handleConfirmChange }: ChangeDialogProps) {
    const { t } = useLicenseText();
    const isDown = preview.direction === 'downgrade';
    const close = () => { setChangeTarget(null); setChangePreview(null); };
    return (
        <Modal
            open
            onClose={() => { if (!changeBusy) close(); }}
            variant="bare"
            size="md"
            labelledBy={labelId}
        >
            <div className={PANEL}>
                <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4" style={{ color: isDown ? '#64748b' : '#3b82f6' }} />
                    <h3 id={labelId} className="text-sm font-bold text-[var(--text-primary)]">
                        {isDown ? t('org.confirm_downgrade', 'Confirm downgrade') : t('org.confirm_upgrade', 'Confirm upgrade')} — {target.name}
                    </h3>
                </div>
                <ChangeCostPreview target={target} preview={preview} />
                <div className="flex justify-end gap-2">
                    <button onClick={close} disabled={changeBusy} className={SECONDARY_BUTTON}>
                        {t('org.cancel', 'Cancel')}
                    </button>
                    <button onClick={handleConfirmChange} disabled={changeBusy} className={`px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white disabled:opacity-50 ${isDown ? '[background:#64748b]' : '[background:#3b82f6]'}`}>
                        {changeBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : t('org.confirm', 'Confirm')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

type CancelDialogProps = Pick<OrgSubscriptionState, 'cancelBusy' | 'setShowCancelConfirm' | 'doCancelSubscription'> & { labelId: string };

/** Cancel-subscription confirmation (in-app, not window.confirm). */
export function CancelSubscriptionDialog({ labelId, cancelBusy, setShowCancelConfirm, doCancelSubscription }: CancelDialogProps) {
    const { t } = useLicenseText();
    return (
        <Modal
            open
            onClose={() => { if (!cancelBusy) setShowCancelConfirm(false); }}
            variant="bare"
            size="md"
            labelledBy={labelId}
        >
            <div className={PANEL}>
                <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <h3 id={labelId} className="text-sm font-bold text-[var(--text-primary)]">{t('org.cancel_subscription', 'Cancel subscription')}</h3>
                </div>
                <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed">
                    {t('org.cancel_confirm_body', 'Cancel your subscription at the end of the current billing period? You keep full access until then, and no further payments will be taken.')}
                </p>
                <div className="flex justify-end gap-2">
                    <button onClick={() => setShowCancelConfirm(false)} disabled={cancelBusy} className={SECONDARY_BUTTON}>
                        {t('org.keep_subscription', 'Keep subscription')}
                    </button>
                    <button onClick={doCancelSubscription} disabled={cancelBusy} className="px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-50">
                        {cancelBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : t('org.cancel_subscription_confirm', 'Cancel subscription')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}

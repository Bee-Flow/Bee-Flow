/**
 * The plan-change confirmation's figures (OrgLicenseSection.jsx change-plan
 * modal) as rows: a downgrade charges nothing today and says when it lands;
 * an upgrade charges the prorated difference now. Both say what the renewal
 * will be, and a per-seat upgrade how many seats it bills.
 */

import type { TranslateFn } from '@/core/i18n';
import { absoluteDate } from '@/shared/lib/display';

import { money } from './subscription';
import type { Plan, PlanChangePreview } from './types';

export interface PreviewRow {
    label: string;
    value: string;
    strong?: boolean;
}

export function previewRows(preview: PlanChangePreview, target: Plan, t: TranslateFn): PreviewRow[] {
    const interval = target.billingInterval === 'yearly' ? t('org.year', 'year') : t('org.month', 'month');
    const then = { label: t('org.then', 'Then'), value: `${money(preview.nextRenewalTotal, preview.currency)} / ${interval}`, strong: true };
    if (preview.direction === 'downgrade') {
        const when = preview.effective ? absoluteDate(preview.effective) : t('org.period_end', 'the end of this period');
        return [
            { label: t('org.takes_effect', 'Takes effect'), value: when },
            { label: t('org.charge_today', 'Charge today'), value: money(0, preview.currency) },
            then,
        ];
    }
    const rows: PreviewRow[] = [
        { label: t('org.prorated_charge_today', 'Prorated charge today'), value: money(preview.prorationAmount, preview.currency) },
        then,
    ];
    if (preview.perSeat && preview.seatQuantity > 0) {
        rows.push({ label: `${preview.seatQuantity} ${t('org.seats', 'seats')}`, value: t('org.billed_per_seat', 'billed per seat') });
    }
    return rows;
}

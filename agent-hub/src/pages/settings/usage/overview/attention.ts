// The "needs attention" rows of the Overview, derived from the data in front of
// us: nothing here is a fixed message, so a clean organisation shows no card.

import type { useTranslation } from '@/hooks/useTranslation';
import { fMoney, fInt } from '../adoption/format';
import { kindMeta, usageNoun } from '../adoption/kindMeta';
import type { ModelRow } from '../OverviewTab.types';
import { isUnknownModel } from '../spend/spendFormat';
import type { OverviewAdoption } from './adoptionData';

type T = ReturnType<typeof useTranslation>['t'];

export interface AttentionRow {
    id: string;
    /** warn: something to act on; note: something to know. */
    tone: 'warn' | 'note';
    text: string;
    moreLabel: string;
    tab: string;
    subTab?: string;
}

/** How many Studio rows the card lists before it leaves the rest to the Adoption tab. */
const MAX_STUDIO_ROWS = 3;

function dormantRow(adoption: OverviewAdoption | null, t: T): AttentionRow[] {
    const m = adoption?.summary?.members;
    if (!m || !m.dormant || m.dormant <= 0) return [];
    const params = { n: fInt(m.dormant), total: fInt(m.total) };
    return [{
        id: 'dormant',
        tone: 'warn',
        text: m.dormant === 1
            ? t('usage.ov_att_dormant_one', '{n} of {total} seats has not signed in for more than 30 days.', params)
            : t('usage.ov_att_dormant', '{n} of {total} seats have not signed in for more than 30 days.', params),
        moreLabel: t('usage.ov_see_who', 'See who'),
        tab: 'adoption',
        subTab: 'people',
    }];
}

function studioRows(adoption: OverviewAdoption | null, t: T): AttentionRow[] {
    const kinds = adoption?.studio?.kinds ?? [];
    return kinds
        .filter(k => k.published > 0 && k.usage && k.usage.events === 0)
        .slice(0, MAX_STUDIO_ROWS)
        .map((k) => {
            const kind = kindMeta(k.kind, t).label.toLowerCase();
            const noun = usageNoun(k.usage!.label, t);
            return {
                id: `studio-${k.kind}`,
                tone: 'warn' as const,
                text: t('usage.ov_att_unused', '{n} published {kind} had no {noun} in this period.', { n: fInt(k.published), kind, noun }),
                moreLabel: t('usage.ov_review_kind', 'Review {kind}', { kind }),
                tab: 'adoption',
                subTab: 'studio',
            };
        });
}

function unknownModelRow(models: ModelRow[], currency: string, t: T): AttentionRow[] {
    const calls = models.filter(m => isUnknownModel(m.model)).reduce((s, m) => s + (Number(m.calls) || 0), 0);
    if (calls <= 0) return [];
    const params = { n: fInt(calls), cost: fMoney(0, currency) };
    return [{
        id: 'unknown-model',
        tone: 'note',
        text: calls === 1
            ? t('usage.ov_att_unknown_one', '{n} call carries no model name and is priced at {cost}.', params)
            : t('usage.ov_att_unknown', '{n} calls carry no model name and are priced at {cost}.', params),
        moreLabel: t('usage.ov_check_models', 'Check models'),
        tab: 'spend',
        subTab: 'models',
    }];
}

interface AttentionInput {
    adoption: OverviewAdoption | null;
    models: ModelRow[];
    isCustomerView: boolean;
    currency: string;
    t: T;
}

export function attentionRows({ adoption, models, isCustomerView, currency, t }: AttentionInput): AttentionRow[] {
    return [
        ...dormantRow(adoption, t),
        ...studioRows(adoption, t),
        ...(isCustomerView ? [] : unknownModelRow(models, currency, t)),
    ];
}

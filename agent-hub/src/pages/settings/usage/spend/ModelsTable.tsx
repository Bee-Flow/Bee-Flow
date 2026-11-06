// Spend → Models: what each model cost, and (opening a row) who and what drove it.

import { Fragment, useState } from 'react';
import { tierLabel } from '@/components/licensing/tierMeta';
import { useTranslation } from '@/hooks/useTranslation';
import { fInt, fMoney } from '../adoption/format';
import { fNum, shortModel } from '../format';
import type { AgentModelRow, ModelRow, ModelUserRow } from '../OverviewTab.types';
import { Chevron } from './Chevron';
import { ModelDrilldown } from './ModelDrilldown';
import { ShareBar, inOutParts } from './ShareBar';
import type { SpendViewProps } from './spend.types';
import { costOf, isUnknownModel, share } from './spendFormat';
import { BADGE, BADGE_WARN, CARD, ROW_BTN, TABLE, TD, TD_MUTED, TD_R, TFOOT, TH, TH_R } from './tableStyle';

type Props = SpendViewProps;

function tokensCell(m: ModelRow, t: ReturnType<typeof useTranslation>['t']): string {
    const hasTokens = (Number(m.prompt_tokens) || 0) + (Number(m.completion_tokens) || 0) > 0;
    if (hasTokens) return `${fNum(m.prompt_tokens)} · ${fNum(m.completion_tokens)}`;
    return isUnknownModel(m.model) || !(Number(m.calls) > 0) ? '—' : t('usage.spend_not_reported', 'not reported');
}

const keyOf = (m: ModelRow) => m.model || 'unknown';

function TierCell({ model, tierForModel, modelTiers }: { model: ModelRow } & Pick<Props, 'tierForModel' | 'modelTiers'>) {
    const { t } = useTranslation();
    if (isUnknownModel(model.model)) return <span className={BADGE_WARN}>{t('usage.spend_unpriced', 'unpriced')}</span>;
    const tierKey = tierForModel?.(model.model) ?? null;
    const tier = tierKey ? tierLabel(tierKey, modelTiers as Parameters<typeof tierLabel>[1]) : '';
    return tier ? <span className={BADGE}>{tier}</span> : null;
}

interface ModelRowsProps extends Props {
    model: ModelRow;
    total: number;
    open: boolean;
    onToggle: () => void;
    byUser: ModelUserRow[];
    byAgent: AgentModelRow[];
    cols: number;
}

function ModelRows({ model: m, total, open, onToggle, byUser, byAgent, cols, currency, showTokens, tierForModel, modelTiers, setFilterModel }: ModelRowsProps) {
    const { t } = useTranslation();
    const unknown = isUnknownModel(m.model);
    const cost = costOf(m);
    const pct = share(cost, total);
    const name = unknown ? t('usage.ov_unknown_model', 'unknown') : shortModel(m.model);
    return (
        <Fragment>
            <tr className={open ? 'bg-[var(--bg-secondary)]' : ''}>
                <td className={TD}>
                    <button type="button" className={ROW_BTN} aria-expanded={open} onClick={onToggle} title={m.model}>
                        <Chevron open={open} />
                        <span className={`truncate ${open ? 'font-semibold' : 'font-medium'} ${unknown ? 'text-[var(--text-muted)]' : ''}`}>{name}</span>
                    </button>
                </td>
                <td className={TD}><TierCell model={m} tierForModel={tierForModel} modelTiers={modelTiers} /></td>
                <td className={TD_R}>{fInt(m.calls)}</td>
                {showTokens && <td className={TD_R}>{tokensCell(m, t)}</td>}
                <td className={TD_R}>{fMoney(Number(m.input_cost) || 0, currency)} · {fMoney(Number(m.output_cost) || 0, currency)}</td>
                <td className={`${TD_R} font-semibold ${unknown ? '!text-[var(--text-muted)]' : ''}`}>{fMoney(cost, currency)}</td>
                <td className={TD}>
                    <span className="inline-flex items-center gap-2">
                        <span className="w-[90px]"><ShareBar parts={inOutParts(Number(m.input_cost) || 0, Number(m.output_cost) || 0, pct)} /></span>
                        <span className="text-xs text-[var(--text-muted)]">{pct}%</span>
                    </span>
                </td>
            </tr>
            {open && (
                <tr className="bg-[var(--bg-secondary)]">
                    <td colSpan={cols} className="px-3 pb-5 pl-9 pt-0">
                        <ModelDrilldown model={m} byUser={byUser} byAgent={byAgent} currency={currency} onFilter={() => setFilterModel(m.model)} />
                    </td>
                </tr>
            )}
        </Fragment>
    );
}

export function ModelsTable(props: Props) {
    const { t } = useTranslation();
    const { data, currency, showTokens } = props;
    const [openModel, setOpenModel] = useState<string | null>(null);
    const models = [...(data.models || [])].sort((a, b) => costOf(b) - costOf(a));
    const byUser = (data.modelsByUser || []) as ModelUserRow[];
    const byAgent = (data.modelsByAgent || []) as AgentModelRow[];
    const total = models.reduce((s, m) => s + costOf(m), 0);
    const cols = showTokens ? 7 : 6;
    const sum = (f: (m: ModelRow) => number) => models.reduce((s, m) => s + f(m), 0);
    if (models.length === 0) {
        return <section className={`${CARD} p-5 text-[13px] text-[var(--text-muted)]`}>{t('usage.no_model_data')}</section>;
    }
    return (
        <section aria-label={t('usage.spend_cost_by_model', 'Cost by model')} className={`${CARD} px-3 pb-1 pt-2`}>
            <div className="overflow-x-auto">
                <table className={`${TABLE} min-w-[860px]`}>
                    <thead>
                        <tr>
                            <th scope="col" className={`${TH} w-[28%]`}>{t('usage.model')}</th>
                            <th scope="col" className={TH}>{t('usage.spend_tier', 'Tier')}</th>
                            <th scope="col" className={TH_R}>{t('usage.ov_calls', 'Calls')}</th>
                            {showTokens && <th scope="col" className={TH_R}>{t('usage.spend_tokens_in_out', 'Tokens in · out')}</th>}
                            <th scope="col" className={TH_R}>{t('usage.spend_cost_in_out', 'Cost in · out')}</th>
                            <th scope="col" className={TH_R}>{t('usage.total')}</th>
                            <th scope="col" className={`${TH} w-[150px]`}>{t('usage.spend_share_of', 'Share of {cost}', { cost: fMoney(total, currency) })}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {models.map(m => (
                            <ModelRows
                                key={keyOf(m)} {...props} model={m} total={total} cols={cols} byUser={byUser} byAgent={byAgent}
                                open={openModel === keyOf(m)} onToggle={() => setOpenModel(o => (o === keyOf(m) ? null : keyOf(m)))}
                            />
                        ))}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td className={TFOOT}>{t('usage.spend_total_models', 'Total · {n} models', { n: models.length })}</td>
                            <td className={TFOOT} />
                            <td className={`${TFOOT} text-right tabular-nums`}>{fInt(sum(m => Number(m.calls) || 0))}</td>
                            {showTokens && <td className={`${TFOOT} text-right font-normal tabular-nums`}>{fNum(sum(m => Number(m.prompt_tokens) || 0))} · {fNum(sum(m => Number(m.completion_tokens) || 0))}</td>}
                            <td className={`${TFOOT} text-right font-normal tabular-nums`}>{fMoney(sum(m => Number(m.input_cost) || 0), currency)} · {fMoney(sum(m => Number(m.output_cost) || 0), currency)}</td>
                            <td className={`${TFOOT} text-right tabular-nums`}>{fMoney(total, currency)}</td>
                            <td className={`${TFOOT} ${TD_MUTED}`} />
                        </tr>
                    </tfoot>
                </table>
            </div>
        </section>
    );
}

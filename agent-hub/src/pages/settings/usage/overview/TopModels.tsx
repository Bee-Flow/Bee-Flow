// "Top models by cost": the five models that cost the most, with the input /
// output split of each as a bar, ending with a link to every model in Spend.

import { useTranslation } from '@/hooks/useTranslation';
import { MoreLink, Swatch } from '../shell';
import { fInt, fMoney } from '../adoption/format';
import { shortModel } from '../format';
import type { ModelRow } from '../OverviewTab.types';
import { IN_COLOR, OUT_COLOR, ShareBar, inOutParts } from '../spend/ShareBar';
import { costOf, isUnknownModel } from '../spend/spendFormat';

interface TopModelsProps {
    models: ModelRow[];
    currency: string;
    onOpenSpend: () => void;
}

const TOP = 5;

export function TopModels({ models, currency, onOpenSpend }: TopModelsProps) {
    const { t } = useTranslation();
    const sorted = [...models].sort((a, b) => costOf(b) - costOf(a));
    const top = sorted.slice(0, TOP);
    const max = top.reduce((m, r) => Math.max(m, costOf(r)), 0);
    return (
        <article className="flex min-w-0 flex-col gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-6 pb-2 pt-5">
            <div className="flex items-baseline justify-between gap-3">
                <h3 className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">{t('usage.ov_top_models', 'Top models by cost')}</h3>
                <span className="inline-flex gap-3 text-xs text-[var(--text-secondary)]">
                    <span className="inline-flex items-center gap-1.5"><Swatch color={IN_COLOR} />{t('usage.ov_in', 'In')}</span>
                    <span className="inline-flex items-center gap-1.5"><Swatch color={OUT_COLOR} />{t('usage.ov_out', 'Out')}</span>
                </span>
            </div>
            {top.length === 0 ? (
                <p className="m-0 py-3 text-[13px] text-[var(--text-muted)]">{t('usage.no_model_data')}</p>
            ) : (
                <table className="w-full border-collapse text-[13px]">
                    <thead>
                        <tr className="text-left text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-muted)]">
                            <th scope="col" className="pb-1.5 font-semibold">{t('usage.model')}</th>
                            <th scope="col" className="pb-1.5 text-right font-semibold">{t('usage.ov_calls', 'Calls')}</th>
                            <th scope="col" className="pb-1.5 text-right font-semibold">{t('usage.ov_cost', 'Cost')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {top.map((m) => {
                            const unknown = isUnknownModel(m.model);
                            const cost = costOf(m);
                            return (
                                <tr key={m.model || 'unknown'} className="border-t border-[var(--border-subtle)] align-top">
                                    <td className="py-2.5 pr-3">
                                        <div className="flex flex-col gap-1.5">
                                            {unknown ? (
                                                <span>
                                                    <span className="font-medium text-[var(--text-muted)]">{t('usage.ov_unknown_model', 'unknown')}</span>{' '}
                                                    <span className="text-xs text-[var(--text-muted)]">{t('usage.ov_unknown_note', 'no model name on the call')}</span>
                                                </span>
                                            ) : (
                                                <>
                                                    <span className="font-medium text-[var(--text-primary)]" title={m.model}>{shortModel(m.model)}</span>
                                                    <ShareBar parts={inOutParts(Number(m.input_cost) || 0, Number(m.output_cost) || 0, max > 0 ? (cost / max) * 100 : 0)} maxWidth={280} />
                                                </>
                                            )}
                                        </div>
                                    </td>
                                    <td className="py-2.5 text-right tabular-nums text-[var(--text-muted)]">{fInt(m.calls)}</td>
                                    <td className={`py-2.5 text-right font-semibold tabular-nums ${unknown ? 'text-[var(--text-muted)]' : 'text-[var(--text-primary)]'}`}>{fMoney(cost, currency)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            <MoreLink label={t('usage.ov_all_models', 'All {n} models in Spend', { n: models.length })} onClick={onOpenSpend} />
        </article>
    );
}

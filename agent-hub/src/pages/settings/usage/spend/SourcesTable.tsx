// Spend → Sources: where in the product the usage came from. A row narrows the page to its source.

import { useTranslation } from '@/hooks/useTranslation';
import { fInt, fMoney } from '../adoption/format';
import { fNum } from '../format';
import { getSourceDetails } from '../widgets';
import { ShareBar } from './ShareBar';
import type { SpendViewProps } from './spend.types';
import { costOf, share } from './spendFormat';
import { CARD, ROW_BTN, TABLE, TD, TD_R, TH, TH_R } from './tableStyle';

export function SourcesTable({ data, currency, showTokens, setFilterSource }: SpendViewProps) {
    const { t } = useTranslation();
    const sources = [...(data.sources || [])].sort((a, b) => costOf(b) - costOf(a));
    const total = sources.reduce((s, r) => s + costOf(r), 0);
    if (sources.length === 0) return <section className={`${CARD} p-5 text-[13px] text-[var(--text-muted)]`}>{t('usage.no_usage_recorded', 'No usage recorded yet')}</section>;
    return (
        <section aria-label={t('usage.by_app_area')} className={`${CARD} px-3 pb-1 pt-2`}>
            <div className="overflow-x-auto">
                <table className={`${TABLE} min-w-[600px]`}>
                    <thead>
                        <tr>
                            <th scope="col" className={`${TH} w-[40%]`}>{t('usage.spend_source', 'Source')}</th>
                            <th scope="col" className={TH_R}>{t('usage.ov_calls', 'Calls')}</th>
                            {showTokens && <th scope="col" className={TH_R}>{t('usage.spend_tokens', 'Tokens')}</th>}
                            <th scope="col" className={TH_R}>{t('usage.total')}</th>
                            <th scope="col" className={`${TH} w-[150px]`}>{t('usage.spend_share_of', 'Share of {cost}', { cost: fMoney(total, currency) })}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sources.map((s) => {
                            const d = getSourceDetails(s.source, t);
                            const Icon = d.icon;
                            const pct = share(costOf(s), total);
                            return (
                                <tr key={s.source}>
                                    <td className={TD}>
                                        <button type="button" className={`${ROW_BTN} hover:underline`} onClick={() => setFilterSource(s.source)} title={t('usage.spend_filter_source', 'Filter by this source')}>
                                            <Icon className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                                            <span className="truncate font-medium">{d.label}</span>
                                        </button>
                                    </td>
                                    <td className={TD_R}>{s.calls == null ? '—' : fInt(s.calls)}</td>
                                    {showTokens && <td className={TD_R}>{fNum(s.total_tokens)}</td>}
                                    <td className={`${TD_R} font-semibold`}>{fMoney(costOf(s), currency)}</td>
                                    <td className={TD}>
                                        <span className="inline-flex items-center gap-2">
                                            <span className="w-[90px]"><ShareBar parts={[{ pct, color: d.color }]} /></span>
                                            <span className="text-xs text-[var(--text-muted)]">{pct}%</span>
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

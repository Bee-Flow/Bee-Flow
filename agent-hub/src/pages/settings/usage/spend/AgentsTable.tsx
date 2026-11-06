// Spend → Agents: which agents drive the usage; opening a row lists the models each used.

import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { fMoney } from '../adoption/format';
import { fNum, shortModel } from '../format';
import type { AgentModelRow } from '../OverviewTab.types';
import { Chevron } from './Chevron';
import { ShareBar } from './ShareBar';
import type { SpendViewProps } from './spend.types';
import { groupByAgent } from './spendData';
import { share } from './spendFormat';
import { CARD, ROW_BTN, TABLE, TD, TD_R, TH, TH_R } from './tableStyle';

export function AgentsTable({ data, currency, showTokens }: SpendViewProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState<string | null>(null);
    const groups = useMemo(
        () => groupByAgent((data.modelsByAgent || []) as AgentModelRow[], t('usage.ov_direct_chat', 'Direct chat')),
        [data.modelsByAgent, t],
    );
    const total = groups.reduce((s, g) => s + g.estimated_cost, 0);
    if (groups.length === 0) return <section className={`${CARD} p-5 text-[13px] text-[var(--text-muted)]`}>{t('usage.no_data_short')}</section>;
    return (
        <section aria-label={t('usage.models_per_agent')} className={`${CARD} px-3 pb-1 pt-2`}>
            <div className="overflow-x-auto">
                <table className={`${TABLE} min-w-[640px]`}>
                    <thead>
                        <tr>
                            <th scope="col" className={`${TH} w-[40%]`}>{t('usage.spend_agent', 'Agent')}</th>
                            <th scope="col" className={TH_R}>{t('usage.spend_models', 'Models')}</th>
                            {showTokens && <th scope="col" className={TH_R}>{t('usage.spend_tokens', 'Tokens')}</th>}
                            <th scope="col" className={TH_R}>{t('usage.total')}</th>
                            <th scope="col" className={`${TH} w-[150px]`}>{t('usage.spend_share_of', 'Share of {cost}', { cost: fMoney(total, currency) })}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map((g) => {
                            const isOpen = open === g.agent_name;
                            const pct = share(g.estimated_cost, total);
                            return (
                                <Fragment key={g.agent_name}>
                                    <tr className={isOpen ? 'bg-[var(--bg-secondary)]' : ''}>
                                        <td className={TD}>
                                            <button type="button" className={ROW_BTN} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : g.agent_name)}>
                                                <Chevron open={isOpen} />
                                                <span className="truncate font-medium">{g.agent_name}</span>
                                            </button>
                                        </td>
                                        <td className={TD_R}>{g.models.length}</td>
                                        {showTokens && <td className={TD_R}>{fNum(g.total_tokens)}</td>}
                                        <td className={`${TD_R} font-semibold`}>{fMoney(g.estimated_cost, currency)}</td>
                                        <td className={TD}>
                                            <span className="inline-flex items-center gap-2">
                                                <span className="w-[90px]"><ShareBar parts={[{ pct, color: 'var(--text-primary)' }]} /></span>
                                                <span className="text-xs text-[var(--text-muted)]">{pct}%</span>
                                            </span>
                                        </td>
                                    </tr>
                                    {isOpen && g.models.map((m, i) => (
                                        <tr key={`${m.model}-${i}`} className="bg-[var(--bg-secondary)] text-xs">
                                            <td className="py-1.5 pl-10 pr-3 text-[var(--text-primary)]">{shortModel(m.model)}</td>
                                            <td />
                                            {showTokens && (
                                                <td className="py-1.5 pr-3 text-right tabular-nums text-[var(--text-muted)]">
                                                    {fNum(Number(m.prompt_tokens) || 0)} · {fNum(Number(m.completion_tokens) || 0)}
                                                </td>
                                            )}
                                            <td className="py-1.5 pr-3 text-right tabular-nums text-[var(--text-primary)]">{fMoney(Number(m.estimated_cost) || 0, currency)}</td>
                                            <td />
                                        </tr>
                                    ))}
                                </Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

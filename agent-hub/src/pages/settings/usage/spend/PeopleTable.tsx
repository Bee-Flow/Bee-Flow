// Spend → People: what each member cost; opening a row shows the models they used.

import { Fragment, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { paletteColor } from '@/config/analyticsConfig';
import { fInt, fMoney } from '../adoption/format';
import { fNum, shortModel } from '../format';
import type { ModelUserRow, UserRow } from '../OverviewTab.types';
import { Avatar } from '../widgets';
import { Chevron } from './Chevron';
import { ShareBar, inOutParts } from './ShareBar';
import type { SpendViewProps } from './spend.types';
import { hasSplitCost, modelsOfUser } from './spendData';
import { costOf, share } from './spendFormat';
import { CARD, GHOST_BTN, PANEL_CARD, ROW_BTN, TABLE, TD, TD_R, TH, TH_R } from './tableStyle';

function UserDetail({ user, rows, currency, showTokens, onModel, onFilter }: {
    user: UserRow; rows: ModelUserRow[]; currency: string; showTokens: boolean;
    onModel: (model: string) => void; onFilter: () => void;
}) {
    const { t } = useTranslation();
    return (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
            <div className={PANEL_CARD}>
                <h4 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{t('usage.spend_models_used', 'Models used')}</h4>
                {rows.length === 0 ? <p className="m-0 text-[13px] text-[var(--text-muted)]">{t('usage.no_data_short')}</p> : (
                    <table className={TABLE}>
                        <tbody>
                            {rows.map(r => (
                                <tr key={r.model} className="border-t border-[var(--border-subtle)] first:border-t-0">
                                    <td className="py-1.5 pr-2">
                                        <button type="button" onClick={() => onModel(r.model)} title={t('usage.spend_filter_model', 'Filter by this model')} className={`${ROW_BTN} hover:underline`}>{shortModel(r.model)}</button>
                                    </td>
                                    {showTokens && <td className="py-1.5 text-right tabular-nums text-[var(--text-muted)]">{fNum(r.total_tokens)}</td>}
                                    <td className="py-1.5 text-right font-semibold tabular-nums">{fMoney(costOf(r), currency)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
            </div>
            <div className={PANEL_CARD}>
                <h4 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{t('usage.spend_narrow', 'Narrow the page')}</h4>
                <p className="m-0 text-[13px] text-[var(--text-secondary)]">{t('usage.spend_narrow_member', 'Show only the usage of {name} in every view.', { name: user.display_name || user.user_id })}</p>
                <button type="button" onClick={onFilter} className={GHOST_BTN}>{t('usage.spend_filter_member', 'Filter by this member')}</button>
            </div>
        </div>
    );
}

export function PeopleTable({ data, currency, showTokens, setFilterUser, setFilterModel }: SpendViewProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState<string | null>(null);
    const users = [...(data.users || [])].sort((a, b) => costOf(b) - costOf(a));
    const byUser = (data.modelsByUser || []) as ModelUserRow[];
    const total = users.reduce((s, u) => s + costOf(u), 0);
    if (users.length === 0) return <section className={`${CARD} p-5 text-[13px] text-[var(--text-muted)]`}>{t('usage.no_active_users')}</section>;
    return (
        <section aria-label={t('usage.spend_cost_by_member', 'Cost by member')} className={`${CARD} px-3 pb-1 pt-2`}>
            <div className="overflow-x-auto">
                <table className={`${TABLE} min-w-[760px]`}>
                    <thead>
                        <tr>
                            <th scope="col" className={`${TH} w-[30%]`}>{t('usage.spend_member', 'Member')}</th>
                            <th scope="col" className={TH_R}>{t('usage.ov_calls', 'Calls')}</th>
                            {showTokens && <th scope="col" className={TH_R}>{t('usage.spend_tokens_in_out', 'Tokens in · out')}</th>}
                            <th scope="col" className={TH_R}>{t('usage.spend_cost_in_out', 'Cost in · out')}</th>
                            <th scope="col" className={TH_R}>{t('usage.total')}</th>
                            <th scope="col" className={`${TH} w-[150px]`}>{t('usage.spend_share_of', 'Share of {cost}', { cost: fMoney(total, currency) })}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((u, i) => {
                            const isOpen = open === u.user_id;
                            const pct = share(costOf(u), total);
                            return (
                                <Fragment key={u.user_id}>
                                    <tr className={isOpen ? 'bg-[var(--bg-secondary)]' : ''}>
                                        <td className={TD}>
                                            <button type="button" className={ROW_BTN} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : u.user_id)}>
                                                <Chevron open={isOpen} />
                                                <Avatar user={u} color={paletteColor(i)} size={22} />
                                                <span className="truncate font-medium">{u.display_name || u.user_id}</span>
                                            </button>
                                        </td>
                                        <td className={TD_R}>{u.calls == null ? '—' : fInt(u.calls)}</td>
                                        {showTokens && <td className={TD_R}>{fNum(u.prompt_tokens)} · {fNum(u.completion_tokens)}</td>}
                                        <td className={TD_R}>{hasSplitCost(u) ? `${fMoney(u.input_cost, currency)} · ${fMoney(u.output_cost, currency)}` : '—'}</td>
                                        <td className={`${TD_R} font-semibold`}>{fMoney(costOf(u), currency)}</td>
                                        <td className={TD}>
                                            <span className="inline-flex items-center gap-2">
                                                <span className="w-[90px]"><ShareBar parts={hasSplitCost(u) ? inOutParts(Number(u.input_cost) || 0, Number(u.output_cost) || 0, pct) : [{ pct, color: 'var(--text-primary)' }]} /></span>
                                                <span className="text-xs text-[var(--text-muted)]">{pct}%</span>
                                            </span>
                                        </td>
                                    </tr>
                                    {isOpen && (
                                        <tr className="bg-[var(--bg-secondary)]">
                                            <td colSpan={showTokens ? 6 : 5} className="px-3 pb-5 pl-9 pt-0">
                                                <UserDetail user={u} rows={modelsOfUser(byUser, u)} currency={currency} showTokens={showTokens} onModel={setFilterModel} onFilter={() => setFilterUser(u.user_id)} />
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </section>
    );
}

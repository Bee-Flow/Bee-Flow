// The panel under an open model row: who used the model and through which
// agent, plus a way to narrow the whole page to it.

import { useTranslation } from '@/hooks/useTranslation';
import { fInt, fMoney } from '../adoption/format';
import type { AgentModelRow, ModelRow, ModelUserRow } from '../OverviewTab.types';
import { isUnknownModel } from './spendFormat';
import { GHOST_BTN, PANEL_CARD, TABLE } from './tableStyle';

interface ModelDrilldownProps {
    model: ModelRow;
    byUser: ModelUserRow[];
    byAgent: AgentModelRow[];
    currency: string;
    onFilter: () => void;
}

interface MiniRow { id: string; name: string; calls: number | null; cost: number }

function MiniTable({ title, nameHead, rows, currency }: { title: string; nameHead: string; rows: MiniRow[]; currency: string }) {
    const { t } = useTranslation();
    const showCalls = rows.some(r => r.calls != null);
    return (
        <div className={PANEL_CARD}>
            <h4 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{title}</h4>
            {rows.length === 0 ? (
                <p className="m-0 text-[13px] text-[var(--text-muted)]">{t('usage.no_data_short')}</p>
            ) : (
                <table className={TABLE}>
                    <thead>
                        <tr className="text-[11px] uppercase tracking-[.06em] text-[var(--text-muted)]">
                            <th scope="col" className="py-1 text-left font-semibold">{nameHead}</th>
                            {showCalls && <th scope="col" className="py-1 text-right font-semibold">{t('usage.ov_calls', 'Calls')}</th>}
                            <th scope="col" className="py-1 text-right font-semibold">{t('usage.ov_cost', 'Cost')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(r => (
                            <tr key={r.id} className="border-t border-[var(--border-subtle)]">
                                <td className="py-1.5 pr-2">{r.name}</td>
                                {showCalls && <td className="py-1.5 text-right tabular-nums">{r.calls == null ? '—' : fInt(r.calls)}</td>}
                                <td className="py-1.5 text-right font-semibold tabular-nums">{fMoney(r.cost, currency)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );
}

export function ModelDrilldown({ model, byUser, byAgent, currency, onFilter }: ModelDrilldownProps) {
    const { t } = useTranslation();
    const users: MiniRow[] = byUser
        .filter(r => r.model === model.model)
        .map(r => ({ id: r.user_id, name: r.display_name || r.user_id, calls: r.calls ?? null, cost: Number(r.estimated_cost) || 0 }))
        .sort((a, b) => b.cost - a.cost);
    const agents: MiniRow[] = byAgent
        .filter(r => r.model === model.model)
        .map(r => ({ id: r.agent_id || r.agent_name || 'direct', name: r.agent_name || t('usage.ov_direct_chat', 'Direct chat'), calls: r.calls ?? null, cost: Number(r.estimated_cost) || 0 }))
        .sort((a, b) => b.cost - a.cost);
    return (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr))]">
            <MiniTable title={t('usage.spend_who_used', 'Who used it')} nameHead={t('usage.spend_member', 'Member')} rows={users} currency={currency} />
            <MiniTable title={t('usage.spend_through_what', 'Through what')} nameHead={t('usage.spend_agent', 'Agent')} rows={agents} currency={currency} />
            <div className={PANEL_CARD}>
                <h4 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{t('usage.spend_narrow', 'Narrow the page')}</h4>
                <p className="m-0 text-[13px] text-[var(--text-secondary)]">
                    {isUnknownModel(model.model)
                        ? t('usage.spend_unknown_note', 'The provider reported no model name for these calls, so they cannot be priced and count as {cost}.', { cost: fMoney(0, currency) })
                        : t('usage.spend_narrow_note', 'Show only the usage of this model in every view.')}
                </p>
                {!isUnknownModel(model.model) && (
                    <button type="button" onClick={onFilter} className={GHOST_BTN}>{t('usage.spend_filter_model', 'Filter by this model')}</button>
                )}
            </div>
        </div>
    );
}

import { useTranslation } from '@/hooks/useTranslation';
import { isLargeInput } from '@/utils/terminationsModel';
import type { ByAgentRow, TerminationRow } from '@/pages/settings/OrgTerminationsPanel.types';

const TH = 'pb-2.5 text-[11px] font-semibold uppercase tracking-[.06em] whitespace-nowrap text-[var(--text-muted)]';
const TD = 'border-t border-[var(--border-subtle)] py-3 text-[13px] text-[var(--text-primary)]';

export interface TerminationsByAgentProps {
    byAgent: ByAgentRow[];
    rows: TerminationRow[];
    showTokens: boolean;
}

export function TerminationsByAgent({ byAgent, rows, showTokens }: TerminationsByAgentProps) {
    const { t } = useTranslation();
    const largeBy = new Map<string, number>();
    for (const r of rows) if (isLargeInput(r, showTokens)) largeBy.set(r.agent_id ?? '', (largeBy.get(r.agent_id ?? '') || 0) + 1);
    return (
        <section aria-label={t('org.terminations_by_agent', 'By agent')} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-6 pb-2 pt-5">
            <h3 className="m-0 mb-3 text-[15px] font-semibold text-[var(--text-primary)]">{t('org.terminations_by_agent_title', 'Terminations by agent')}</h3>
            <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] border-collapse">
                    <thead>
                        <tr>
                            <th className={`${TH} text-left`}>{t('org.terminations_col_agent', 'Agent')}</th>
                            <th className={`${TH} text-right`}>{t('org.terminations_col_total', 'Total')}</th>
                            <th className={`${TH} text-right`}>{t('org.terminations_kpi_max_tokens', 'Max tokens')}</th>
                            <th className={`${TH} text-right`}>{t('org.terminations_kpi_max_iterations', 'Max iterations')}</th>
                            <th className={`${TH} text-right`}>{t('org.terminations_col_errors', 'Errors')}</th>
                            <th className={`${TH} text-right`}>{t('org.terminations_col_aborted', 'Aborted')}</th>
                            <th className={`${TH} text-right`}>{t('org.terminations_large_input', 'Large input')}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {byAgent.map(a => {
                            const large = largeBy.get(a.agent_id ?? '') || 0;
                            return (
                                <tr key={a.agent_id || 'unknown'}>
                                    <td className={`${TD} font-medium`}>{a.agent_name || a.agent_id || '—'}</td>
                                    <td className={`${TD} text-right font-semibold`}>{a.total}</td>
                                    <td className={`${TD} text-right`}>{a.max_tokens || 0}</td>
                                    <td className={`${TD} text-right`}>{a.max_iterations || 0}</td>
                                    <td className={`${TD} text-right`}>{a.errors || 0}</td>
                                    <td className={`${TD} text-right`}>{a.aborted || 0}</td>
                                    <td className={`${TD} text-right`}>
                                        {large > 0
                                            ? <span className="inline-flex items-center rounded-md bg-[color-mix(in_srgb,var(--warning)_18%,transparent)] px-[7px] py-[3px] text-xs font-semibold text-[var(--warning)]">{large}</span>
                                            : 0}
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

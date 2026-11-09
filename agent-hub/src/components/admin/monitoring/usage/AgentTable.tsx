import type { Dispatch, SetStateAction } from 'react';
import { ChevronRight, Cpu } from 'lucide-react';
import DataTable, { TableCell, TableRow, type TableColumn } from '@/components/shared/DataTable';
import { useTranslation } from '@/hooks/useTranslation';
import { agentChipClass, fmt, fmtCost, fmtDuration, shortModel, Empty, TablePanel, type AgentUsage } from '../shared';

interface AgentTableProps {
    agents: AgentUsage[];
    expandedAgent: string | null;
    setExpandedAgent: Dispatch<SetStateAction<string | null>>;
}

const agentKey = (a: AgentUsage) => a.agent_name || a.agent_id;

/** The models one agent used, under its row. */
function AgentModels({ agent }: { agent: AgentUsage }) {
    const { t } = useTranslation();
    return (
        <div role="row" className="border-b border-[var(--border-default)] bg-[var(--bg-secondary)] py-1 pl-10 pr-3.5">
            {(agent.models || []).map((m, mi) => (
                <div key={mi} role="cell" className="flex items-center justify-between gap-3 py-1.5 text-[11px]">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <Cpu className="h-3 w-3 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <span className="truncate font-semibold text-[var(--text-primary)]">{shortModel(m.model)}</span>
                    </span>
                    <span className="flex items-center gap-3 tabular-nums">
                        <span className="font-semibold text-[var(--text-primary)]">{fmt(m.total_tokens)}</span>
                        <span className="text-[var(--text-tertiary)]">{t('admin_monitoring.usage_n_calls', '{n} calls', { n: m.calls })}</span>
                        <span className="text-[var(--text-secondary)]">{fmtCost(m.estimated_cost || 0)}</span>
                    </span>
                </div>
            ))}
        </div>
    );
}

/** By Agent: one row per agent, opening onto the models it used. */
export function AgentTable({ agents, expandedAgent, setExpandedAgent }: AgentTableProps) {
    const { t } = useTranslation();
    const title = t('admin_monitoring.usage_by_agent', 'By Agent');
    const columns: TableColumn[] = [
        { id: 'agent', label: t('admin_monitoring.col_agent', 'Agent'), width: 'minmax(0,1fr)' },
        { id: 'avg', label: t('admin_monitoring.col_latency', 'Latency'), width: '90px', align: 'right' },
        { id: 'tokens', label: t('admin_monitoring.col_tokens', 'Tokens'), width: '80px', align: 'right' },
        { id: 'calls', label: t('admin_monitoring.usage_col_calls', 'Calls'), width: '90px', align: 'right' },
        { id: 'cost', label: t('admin_monitoring.col_cost', 'Cost'), width: '80px', align: 'right' },
        { id: 'open', label: '', width: '20px' },
    ];
    return (
        <TablePanel title={title}>
            <DataTable<AgentUsage>
                ariaLabel={title}
                columns={columns}
                rows={agents}
                rowKey={(a, i) => agentKey(a) || i}
                empty={<Empty text={t('admin_monitoring.usage_no_agent', 'No agent data')} />}
                renderRow={(a) => {
                    const isExpanded = expandedAgent === agentKey(a);
                    return (
                        <>
                            <TableRow columns={columns} expanded={isExpanded} ariaExpanded={isExpanded} onClick={() => setExpandedAgent(isExpanded ? null : agentKey(a))}>
                                <TableCell column={columns[0]}>
                                    <span className="flex min-w-0 items-center gap-2">
                                        <span className={agentChipClass(a.agent_type)}>{a.agent_type || 'chat'}</span>
                                        <span className="truncate text-xs font-semibold text-[var(--text-primary)]">{a.agent_name || a.agent_id || t('admin_monitoring.unknown', 'Unknown')}</span>
                                    </span>
                                </TableCell>
                                <TableCell column={columns[1]} className="tabular-nums text-[var(--text-tertiary)]">{t('admin_monitoring.usage_avg', '{duration} avg', { duration: fmtDuration(a.avg_duration_ms) })}</TableCell>
                                <TableCell column={columns[2]} className="font-semibold tabular-nums text-[var(--text-primary)]">{fmt(a.total_tokens)}</TableCell>
                                <TableCell column={columns[3]} className="tabular-nums text-[var(--text-tertiary)]">{t('admin_monitoring.usage_n_calls', '{n} calls', { n: a.calls })}</TableCell>
                                <TableCell column={columns[4]} className="tabular-nums text-[var(--text-secondary)]">{fmtCost(a.estimated_cost || 0)}</TableCell>
                                <TableCell column={columns[5]}>
                                    <ChevronRight className={`h-3.5 w-3.5 text-[var(--text-tertiary)] transition-transform ${isExpanded ? 'rotate-90' : ''}`} aria-hidden="true" />
                                </TableCell>
                            </TableRow>
                            {isExpanded && (a.models || []).length > 0 && <AgentModels agent={a} />}
                        </>
                    );
                }}
            />
        </TablePanel>
    );
}

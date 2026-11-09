import { useState, useMemo } from 'react';
import { CHIP } from '@/components/mcpLibrary/ui';
import {
    fmt, fmtCost, shortModel,
    FilterBar, SortableTable, InOutBar, InOutLabel, SeriesDot, TablePanel,
    type AgentUsage, type FilterState, type ModelUsage, type SortableColumn, type UsageRecord, type UserUsage,
} from './shared';
import { chartSeriesVar } from '@/components/shared/charts/chartChrome';
import { AgentTable } from './usage/AgentTable';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';

interface UsageExplorerPageProps {
    byModel: ModelUsage[];
    byAgent: AgentUsage[];
    byUser: UserUsage[];
    byConversation: UsageRecord[];
    costPerModel: Record<string, number>;
    onSelectModel?: (model: UsageRecord) => void;
}

const NUM = 'text-xs tabular-nums text-[var(--text-primary)]';
const NUM_QUIET = 'text-xs tabular-nums text-[var(--text-secondary)]';

function modelColumns(t: TranslateFn, costPerModel: Record<string, number>): SortableColumn<ModelUsage>[] {
    return [
        {
            key: 'model', label: t('admin_monitoring.col_model', 'Model'), width: '2fr', sortable: true,
            render: (row, i) => (
                <span className="flex min-w-0 items-center gap-2">
                    <SeriesDot color={chartSeriesVar(i)} />
                    <span className="truncate text-xs font-semibold text-[var(--text-primary)]" title={row.model}>{shortModel(row.model)}</span>
                </span>
            ),
        },
        {
            key: 'tokens_bar', label: t('admin_monitoring.usage_in_out', 'In / Out'), width: '1.2fr', sortable: false,
            render: (row) => (
                <div>
                    <InOutBar input={row.prompt_tokens} output={row.completion_tokens} className="max-w-[100px]" />
                    <InOutLabel input={row.prompt_tokens} output={row.completion_tokens} />
                </div>
            ),
        },
        { key: 'total_tokens', label: t('admin_monitoring.col_tokens', 'Tokens'), width: '80px', align: 'right', sortable: true, render: (row) => <span className={`${NUM} font-semibold`}>{fmt(row.total_tokens)}</span> },
        { key: 'calls', label: t('admin_monitoring.usage_col_calls', 'Calls'), width: '70px', align: 'right', sortable: true, render: row => <span className={NUM_QUIET}>{row.calls}</span> },
        { key: 'cost', label: t('admin_monitoring.col_cost', 'Cost'), width: '80px', align: 'right', sortable: false, render: row => <span className={NUM}>{fmtCost(costPerModel[row.model] || row.estimated_cost || 0)}</span> },
    ];
}

function userColumns(t: TranslateFn): SortableColumn<UserUsage>[] {
    return [
        {
            key: 'display_name', label: t('admin_monitoring.d_user', 'User'), width: '1.5fr', sortable: true,
            render: (row) => (
                <span className="flex min-w-0 items-center gap-2">
                    <span aria-hidden="true" className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--bg-tertiary)] text-[10px] font-semibold text-[var(--text-secondary)]">
                        {(row.display_name || '?')[0].toUpperCase()}
                    </span>
                    <span className="min-w-0">
                        <span className="block truncate text-xs font-semibold text-[var(--text-primary)]">{row.display_name || row.user_id}</span>
                        {row.display_name && row.user_id && row.display_name !== row.user_id && (
                            <span className="block truncate text-[10px] text-[var(--text-tertiary)]">{row.user_id}</span>
                        )}
                    </span>
                </span>
            ),
        },
        { key: 'tokens_bar', label: t('admin_monitoring.usage_in_out', 'In / Out'), width: '1fr', sortable: false, render: row => <InOutBar input={row.prompt_tokens} output={row.completion_tokens} className="max-w-[100px]" /> },
        { key: 'total_tokens', label: t('admin_monitoring.col_tokens', 'Tokens'), width: '80px', align: 'right', sortable: true, render: row => <span className={`${NUM} font-semibold`}>{fmt(row.total_tokens)}</span> },
        { key: 'calls', label: t('admin_monitoring.usage_col_calls', 'Calls'), width: '60px', align: 'right', sortable: true, render: row => <span className={NUM_QUIET}>{row.calls}</span> },
        { key: 'estimated_cost', label: t('admin_monitoring.col_cost', 'Cost'), width: '80px', align: 'right', sortable: true, render: row => <span className={NUM}>{fmtCost(row.estimated_cost || 0)}</span> },
    ];
}

function conversationColumns(t: TranslateFn): SortableColumn<UsageRecord>[] {
    return [
        {
            key: 'agent_name', label: t('admin_monitoring.col_agent', 'Agent'), width: '1.5fr', sortable: true,
            render: row => (
                <span className="block min-w-0">
                    <span className="block truncate text-xs font-semibold text-[var(--text-primary)]">{row.agent_name || 'Direct Chat'}</span>
                    <span className="block font-mono text-[10px] text-[var(--text-tertiary)]">{row.conversation_id?.slice(0, 8)}…</span>
                </span>
            ),
        },
        { key: 'calls', label: t('admin_monitoring.usage_col_calls', 'Calls'), width: '70px', align: 'right', sortable: true, render: row => <span className={NUM_QUIET}>{row.calls}</span> },
        { key: 'total_tokens', label: t('admin_monitoring.col_tokens', 'Tokens'), width: '80px', align: 'right', sortable: true, render: row => <span className={`${NUM} font-semibold`}>{fmt(row.total_tokens)}</span> },
        { key: 'estimated_cost', label: t('admin_monitoring.col_cost', 'Cost'), width: '80px', align: 'right', sortable: true, render: row => <span className={NUM}>{fmtCost(row.estimated_cost || 0)}</span> },
        {
            key: 'models_used', label: t('admin_monitoring.usage_col_models', 'Models'), width: '1.2fr', sortable: false,
            render: row => (
                <span className="flex flex-wrap gap-1">
                    {(row.models_used || '').split(',').filter(Boolean).slice(0, 3).map((m, j) => (
                        <span key={j} className={CHIP}><SeriesDot color={chartSeriesVar(j)} />{shortModel(m.trim())}</span>
                    ))}
                </span>
            ),
        },
    ];
}

/** The filters narrow every table on the page: users, agents and models by their own key, conversations by agent and user. */
function useFiltered({ byModel, byAgent, byUser, byConversation }: UsageExplorerPageProps, filters: FilterState) {
    return useMemo(() => ({
        models: filters.model ? byModel.filter(m => m.model === filters.model) : byModel,
        agents: filters.agent ? byAgent.filter(a => (a.agent_name || a.agent_id) === filters.agent) : byAgent,
        users: filters.user ? byUser.filter(u => u.user_id === filters.user) : byUser,
        conversations: byConversation
            .filter(c => !filters.agent || c.agent_name === filters.agent)
            .filter(c => !filters.user || c.user_id === filters.user),
    }), [byModel, byAgent, byUser, byConversation, filters]);
}

export function UsageExplorerPage(props: UsageExplorerPageProps) {
    const { byModel, byAgent, byUser, costPerModel, onSelectModel } = props;
    const { t } = useTranslation();
    const [filters, setFilters] = useState<FilterState>({ user: null, agent: null, model: null, source: null });
    const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

    const userOptions = useMemo(() => byUser.map(u => ({ value: u.user_id, label: u.display_name || u.user_id })), [byUser]);
    const agentOptions = useMemo(() => byAgent.map(a => ({ value: a.agent_name || a.agent_id, label: a.agent_name || t('admin_monitoring.unknown', 'Unknown') })), [byAgent, t]);
    const modelOptions = useMemo(() => byModel.map(m => ({ value: m.model, label: shortModel(m.model) })), [byModel]);
    const filtered = useFiltered(props, filters);
    const byModelTitle = t('admin_monitoring.usage_by_model', 'By Model');
    const byUserTitle = t('admin_monitoring.usage_by_user', 'By User');
    const conversationsTitle = t('admin_monitoring.usage_conversations', 'Conversations');

    return (
        <div className="flex flex-col gap-5">
            <FilterBar filters={filters} setFilters={setFilters} userOptions={userOptions} agentOptions={agentOptions} modelOptions={modelOptions} />

            <div className="grid gap-5 xl:grid-cols-2">
                <TablePanel title={byModelTitle}>
                    <SortableTable ariaLabel={byModelTitle} columns={modelColumns(t, costPerModel)} data={filtered.models} emptyText={t('admin_monitoring.usage_no_model', 'No model data')} onRowClick={onSelectModel} />
                </TablePanel>
                <TablePanel title={byUserTitle}>
                    <SortableTable
                        ariaLabel={byUserTitle} columns={userColumns(t)} data={filtered.users} emptyText={t('admin_monitoring.usage_no_user', 'No user data')}
                        onRowClick={u => setFilters(f => ({ ...f, user: f.user === u.user_id ? null : u.user_id }))}
                    />
                </TablePanel>
            </div>

            <AgentTable agents={filtered.agents} expandedAgent={expandedAgent} setExpandedAgent={setExpandedAgent} />

            {filtered.conversations.length > 0 && (
                <TablePanel title={conversationsTitle}>
                    <SortableTable ariaLabel={conversationsTitle} columns={conversationColumns(t)} data={filtered.conversations} emptyText={t('admin_monitoring.usage_no_convo', 'No conversation data')} maxRows={20} />
                </TablePanel>
            )}
        </div>
    );
}


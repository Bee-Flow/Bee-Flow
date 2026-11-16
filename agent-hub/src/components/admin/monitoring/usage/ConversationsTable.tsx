// The period's conversations by cost: the one table the Usage explorer had
// that Spend did not. A view of Spend now (its "Conversations" sub-tab), fed
// by the monitor's own by-conversation read, so the old explorer page is gone.
// That read answers the newest conversations first with their cost as
// `total_cost` (a pg SUM: a number or a string), and knows nothing of Spend's
// filter bar, so the view orders by cost and narrows by the filters itself.

import { useMemo } from 'react';
import { CHIP } from '@/components/mcpLibrary/ui';
import { chartSeriesVar } from '@/components/shared/charts/chartChrome';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { Empty, fmt, fmtCost, shortModel, SeriesDot, SortableTable, type SortableColumn, type UsageRecord } from '../shared';

/** Spend's filter bar as its host views get it (SpendViewFilters in pages/settings/usage/spend/SpendTab; null: not filtered). */
interface ConversationFilters {
    user: string | null;
    agent: string | null;
    model: string | null;
    source: string | null;
}

/** A conversation's cost: `total_cost` from the by-conversation read (older rows: `estimated_cost`). */
function costOf(row: UsageRecord): number {
    const n = Number(row.total_cost ?? row.estimated_cost ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/** The comma-separated list of a by-conversation row (`models_used`, `sources_used`). */
function listOf(value: unknown): string[] {
    return typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
}

/** The rows the agent, model and source filters leave (the agent filter holds an agent id, or a name for a row without one). */
function narrowed(rows: readonly UsageRecord[], filters: ConversationFilters): UsageRecord[] {
    return rows
        .filter(r => !filters.agent || r.agent_id === filters.agent || r.agent_name === filters.agent)
        .filter(r => !filters.model || listOf(r.models_used).includes(filters.model))
        .filter(r => !filters.source || listOf(r.sources_used).includes(filters.source))
        .map(r => ({ ...r, cost: costOf(r) }))
        .sort((a, b) => costOf(b) - costOf(a));
}

const NUM = 'text-xs tabular-nums text-[var(--text-primary)]';
const NUM_QUIET = 'text-xs tabular-nums text-[var(--text-secondary)]';

function conversationColumns(t: TranslateFn): SortableColumn<UsageRecord>[] {
    return [
        {
            key: 'agent_name', label: t('admin_monitoring.col_agent', 'Agent'), width: '1.5fr', sortable: true,
            render: row => (
                <span className="block min-w-0">
                    <span className="block truncate text-xs font-semibold text-[var(--text-primary)]">{row.agent_name || t('admin_monitoring.direct_chat', 'Direct chat')}</span>
                    {row.conversation_id && <span className="block font-mono text-[10px] text-[var(--text-tertiary)]">{row.conversation_id.slice(0, 8)}…</span>}
                </span>
            ),
        },
        { key: 'calls', label: t('admin_monitoring.usage_col_calls', 'Calls'), width: '70px', align: 'right', sortable: true, render: row => <span className={NUM_QUIET}>{row.calls}</span> },
        { key: 'total_tokens', label: t('admin_monitoring.col_tokens', 'Tokens'), width: '80px', align: 'right', sortable: true, render: row => <span className={`${NUM} font-semibold`}>{fmt(row.total_tokens)}</span> },
        { key: 'cost', label: t('admin_monitoring.col_cost', 'Cost'), width: '80px', align: 'right', sortable: true, render: row => <span className={NUM}>{fmtCost(costOf(row))}</span> },
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

/**
 * The conversations of the period, the most expensive first (the first 20),
 * narrowed by Spend's filters. The read has no member per conversation, so a
 * member filter says so instead of showing everyone's conversations.
 */
export function ConversationsTable({ rows, filters }: { rows: readonly UsageRecord[]; filters: ConversationFilters }) {
    const { t } = useTranslation();
    const data = useMemo(() => narrowed(rows, filters), [rows, filters]);
    if (filters.user) {
        return <Empty text={t('admin_monitoring.conversations_no_member_filter', 'Conversations are not split by member: clear the member filter to see them.')} />;
    }
    return (
        <SortableTable
            ariaLabel={t('admin_monitoring.usage_conversations', 'Conversations')}
            columns={conversationColumns(t)}
            data={data}
            emptyText={t('admin_monitoring.usage_no_convo', 'No conversation data')}
            maxRows={20}
        />
    );
}

import type { ReactNode } from 'react';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import DataTable, { TABLE_FOLDED_ONLY, TableCell, TableRow } from '@/components/shared/DataTable';
import { useTranslation } from '@/hooks/useTranslation';
import { Badge, type BadgeTone } from '../ui/Badge';
import { useSortedRows, type SortableColumnDef } from '../ui/useSortedRows';

/** One organization subscription in `GET /api/subscriptions/orgs`. */
export interface OrgSubscription {
    organization_id: string;
    org_name?: string;
    plan_name?: string | null;
    status: string;
    current_usage?: { messages?: number; cost?: number } | null;
    effective_limits?: { max_messages_per_month?: number | null; max_cost_per_month?: number | null } | null;
}

/** The row as DataTable reads it (it keys rows by organization_id, see rowKey). */
type SubRow = OrgSubscription & { id?: string };

const STATUS_TONE: Record<string, BadgeTone> = { active: 'success', trialing: 'info', suspended: 'warning', manual_action_required: 'warning', cancelled: 'danger' };

/** From 80 % of a limit a warning, from 90 % an error. */
function LimitWarning({ pct }: { pct: number | null }) {
    if (pct == null || pct < 80) return null;
    return <AlertTriangle className={`ml-1 inline h-3.5 w-3.5 align-middle ${pct >= 90 ? 'text-[var(--error-ink)]' : 'text-[var(--warning-ink)]'}`} />;
}

const pctOf = (used: number | undefined, limit: number | null | undefined) => (limit ? Math.round((used || 0) / limit * 100) : null);

interface SubscriptionsTableProps {
    subs: OrgSubscription[];
    onOpen: (sub: OrgSubscription) => void;
    /** Shown in the table when no subscription matches. */
    empty: ReactNode;
}

/** The subscribed organisations: plan, status and this month's usage against its limits (a warning from 80 %). */
export function SubscriptionsTable({ subs, onOpen, empty }: SubscriptionsTableProps) {
    const { t } = useTranslation();
    const defs: SortableColumnDef<OrgSubscription>[] = [
        { id: 'org', label: t('admin_subscriptions.orgs_col_org', 'Organization'), width: 'minmax(0,1.4fr)', sortValue: s => s.org_name },
        { id: 'plan', label: t('admin_subscriptions.orgs_col_plan', 'Plan'), width: 'minmax(0,1fr)', foldBelow: 900, sortValue: s => s.plan_name || '' },
        { id: 'status', label: t('admin_subscriptions.orgs_col_status', 'Status'), width: '100px', sortValue: s => s.status },
        { id: 'messages', label: t('admin_subscriptions.orgs_col_messages', 'Messages'), width: '150px', sortValue: s => s.current_usage?.messages || 0 },
        { id: 'cost', label: t('admin_subscriptions.orgs_col_cost', 'Cost'), width: '150px', sortValue: s => s.current_usage?.cost || 0 },
        { id: 'open', label: '', width: '20px', align: 'right' },
    ];
    const { sorted, columns } = useSortedRows(subs, defs);
    const [org, plan, status, messages, cost, open] = columns;
    // The server's enum as is, except the one that is a sentence rather than a word.
    const statusLabel = (s: string) => (s === 'manual_action_required' ? t('admin_subscriptions.orgs_status_manual_action_required', 'Action required') : s);
    return (
        <DataTable<SubRow>
            columns={columns}
            rows={sorted as SubRow[]}
            rowKey={s => s.organization_id}
            ariaLabel={t('admin_subscriptions.orgs_active_title', 'Active subscriptions')}
            empty={empty}
            cardsBelow={640}
            renderCard={(sub) => (
                <button type="button" onClick={() => onOpen(sub)} className="flex w-full min-w-0 items-center gap-3 text-left">
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{sub.org_name}</div>
                        <div className="mt-0.5 text-[11px] tabular-nums text-[var(--text-tertiary)]">
                            {sub.plan_name || t('admin_subscriptions.orgs_custom', 'Custom')} · {(sub.current_usage?.messages || 0).toLocaleString()} · €{(sub.current_usage?.cost || 0).toFixed(2)}
                        </div>
                    </div>
                    <Badge tone={STATUS_TONE[sub.status] || 'neutral'} size="sm">{statusLabel(sub.status)}</Badge>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                </button>
            )}
            renderRow={(sub) => {
                const msgLimit = sub.effective_limits?.max_messages_per_month;
                const costLimit = sub.effective_limits?.max_cost_per_month;
                const planName = sub.plan_name || t('admin_subscriptions.orgs_custom', 'Custom');
                return (
                    <TableRow columns={columns} onClick={() => onOpen(sub)}>
                        <TableCell column={org}>
                            <div className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{sub.org_name}</div>
                            {/* The plan column folds first on a narrow card; the plan moves under the name. */}
                            <div className={`${TABLE_FOLDED_ONLY[900]} truncate text-[11px] text-[var(--text-tertiary)]`}>{planName}</div>
                        </TableCell>
                        <TableCell column={plan} className="truncate text-[var(--text-secondary)]">{planName}</TableCell>
                        <TableCell column={status}><Badge tone={STATUS_TONE[sub.status] || 'neutral'} size="sm">{statusLabel(sub.status)}</Badge></TableCell>
                        <TableCell column={messages} className="tabular-nums text-[var(--text-secondary)]">
                            {(sub.current_usage?.messages || 0).toLocaleString()}{msgLimit ? ` / ${msgLimit.toLocaleString()}` : ''}
                            <LimitWarning pct={pctOf(sub.current_usage?.messages, msgLimit)} />
                        </TableCell>
                        <TableCell column={cost} className="tabular-nums text-[var(--text-secondary)]">
                            €{(sub.current_usage?.cost || 0).toFixed(4)}{costLimit ? ` / €${costLimit.toFixed(2)}` : ''}
                            <LimitWarning pct={pctOf(sub.current_usage?.cost, costLimit)} />
                        </TableCell>
                        <TableCell column={open} className="text-[var(--text-tertiary)]"><ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></TableCell>
                    </TableRow>
                );
            }}
        />
    );
}

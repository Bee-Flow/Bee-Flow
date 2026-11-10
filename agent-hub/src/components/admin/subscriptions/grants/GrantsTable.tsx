import { CalendarPlus, Copy, Trash2 } from 'lucide-react';
import DataTable, { TABLE_FOLDED_ONLY, TableCell, TableRow } from '@/components/shared/DataTable';
import IconButton from '@/components/shared/IconButton';
import { useTranslation } from '@/hooks/useTranslation';
import { Badge, type BadgeTone } from '../ui/Badge';
import { useSortedRows, type SortableColumnDef } from '../ui/useSortedRows';

/** One issued license, as the admin list endpoint sends it. */
export interface Grant {
    id: string;
    scope?: string;
    organizationId?: string | null;
    organizationName?: string | null;
    tier?: string;
    refreshStatus: string;
    issuedAt?: string | number | Date;
    expiresAt?: string | number | Date;
    metadata?: { admin_notes?: string } | null;
    blob: string;
}

const STATUS_TONE: Record<string, BadgeTone> = { active: 'success', pending: 'success', grace: 'warning', expired: 'neutral', revoked: 'danger' };

const fmtDate = (s: string | number | Date | undefined) => s ? new Date(s).toLocaleDateString() : '—';
const time = (s: string | number | Date | undefined) => s ? new Date(s).getTime() : null;
const isServerLicense = (g: Grant) => g.scope === 'server' || (!g.organizationId && !g.organizationName);

interface GrantsTableProps {
    grants: Grant[];
    onCopy: (blob: string) => void;
    onExtend: (id: string, current: Grant['expiresAt']) => void;
    onRevoke: (grant: Grant) => void;
}

/** Copy, and while the grant is not revoked, extend and revoke. */
function GrantActions({ g, onCopy, onExtend, onRevoke }: { g: Grant } & Omit<GrantsTableProps, 'grants'>) {
    const { t } = useTranslation();
    return (
        <div className="inline-flex shrink-0 items-center gap-1">
            {g.blob && <IconButton size="sm" ariaLabel={t('admin_subscriptions.grants_copy_blob', 'Copy blob')} onClick={() => onCopy(g.blob)}><Copy /></IconButton>}
            {g.refreshStatus !== 'revoked' && (
                <>
                    <IconButton size="sm" ariaLabel={t('admin_subscriptions.grants_extend', 'Extend expiry')} onClick={() => onExtend(g.id, g.expiresAt)}><CalendarPlus /></IconButton>
                    <IconButton size="sm" variant="danger" ariaLabel={t('admin_subscriptions.grants_revoke', 'Revoke')} onClick={() => onRevoke(g)}><Trash2 /></IconButton>
                </>
            )}
        </div>
    );
}

/** The issued licenses: sortable, the dates and notes fold away on a narrow card. */
export function GrantsTable({ grants, onCopy, onExtend, onRevoke }: GrantsTableProps) {
    const { t } = useTranslation();
    const defs: SortableColumnDef<Grant>[] = [
        { id: 'org', label: t('admin_subscriptions.grants_col_org', 'Organization'), width: 'minmax(0,1.4fr)', sortValue: g => isServerLicense(g) ? '' : (g.organizationName || g.organizationId) },
        { id: 'tier', label: t('admin_subscriptions.grants_col_tier', 'Tier'), width: '110px', sortValue: g => g.tier },
        { id: 'status', label: t('admin_subscriptions.grants_col_status', 'Status'), width: '100px', sortValue: g => g.refreshStatus },
        { id: 'issued', label: t('admin_subscriptions.grants_col_issued', 'Issued'), width: '100px', sortValue: g => time(g.issuedAt) },
        { id: 'expires', label: t('admin_subscriptions.grants_col_expires', 'Expires'), width: '100px', sortValue: g => time(g.expiresAt) },
        { id: 'notes', label: t('admin_subscriptions.grants_col_notes', 'Notes'), width: 'minmax(0,1fr)', foldBelow: 1180 },
        { id: 'actions', label: t('admin_subscriptions.grants_col_actions', 'Actions'), width: '104px', align: 'right' },
    ];
    const { sorted, columns } = useSortedRows(grants, defs);
    const [org, tier, status, issued, expires, notes, actions] = columns;
    return (
        <DataTable<Grant>
            columns={columns}
            rows={sorted}
            ariaLabel={t('admin_subscriptions.grants_title', 'Admin License Grants')}
            cardsBelow={640}
            renderCard={(g) => (
                <div className="flex w-full min-w-0 items-center gap-3">
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] text-[var(--text-primary)]">
                            {isServerLicense(g) ? <span className="italic text-[var(--text-tertiary)]">{t('admin_subscriptions.grants_server_license', 'Server license')}</span> : (g.organizationName || g.organizationId)}
                        </div>
                        <div className="mt-0.5 text-[11px] capitalize text-[var(--text-tertiary)]">{g.tier} · {fmtDate(g.expiresAt)}</div>
                    </div>
                    <Badge tone={STATUS_TONE[g.refreshStatus] || 'neutral'} size="sm">{g.refreshStatus}</Badge>
                    <GrantActions g={g} onCopy={onCopy} onExtend={onExtend} onRevoke={onRevoke} />
                </div>
            )}
            renderRow={(g) => (
                <TableRow columns={columns}>
                    <TableCell column={org} className="text-[13px] text-[var(--text-primary)]">
                        <div className="truncate">
                            {isServerLicense(g)
                                ? <span className="italic text-[var(--text-tertiary)]">{t('admin_subscriptions.grants_server_license', 'Server license')}</span>
                                : (g.organizationName || g.organizationId)}
                        </div>
                        {/* The notes column folds first; its text moves under the name. */}
                        {g.metadata?.admin_notes && <div className={`${TABLE_FOLDED_ONLY[1180]} truncate text-[11px] text-[var(--text-tertiary)]`}>{g.metadata.admin_notes}</div>}
                    </TableCell>
                    <TableCell column={tier} className="capitalize text-[var(--text-secondary)]">{g.tier}</TableCell>
                    <TableCell column={status}><Badge tone={STATUS_TONE[g.refreshStatus] || 'neutral'} size="sm">{g.refreshStatus}</Badge></TableCell>
                    <TableCell column={issued} className="tabular-nums text-[var(--text-tertiary)]">{fmtDate(g.issuedAt)}</TableCell>
                    <TableCell column={expires} className="tabular-nums text-[var(--text-tertiary)]">{fmtDate(g.expiresAt)}</TableCell>
                    <TableCell column={notes} className="truncate text-[var(--text-secondary)]">
                        <span title={g.metadata?.admin_notes || ''}>{g.metadata?.admin_notes || '—'}</span>
                    </TableCell>
                    <TableCell column={actions}>
                        <GrantActions g={g} onCopy={onCopy} onExtend={onExtend} onRevoke={onRevoke} />
                    </TableCell>
                </TableRow>
            )}
        />
    );
}

import { History } from 'lucide-react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import DataTable, { TableRow, TableCell, type TableColumn } from '@/components/shared/DataTable';
import EmptyState from '@/components/shared/EmptyState';
import StatusPill from '../../shared/StatusPill';
import { useKbQueryLogOverviewQuery } from '@/api/queries/complianceReads';
import { KQL_AUDIT_ACTIONS, type KqlKbRow } from '@/api/kbQueryLog.types';
import { presetAccessAuditActions } from '../../data/accessAuditPreset';
import { ActionButton, Intro, ReadFailed, RegisterLayout, fmtStamp, labelOf } from '../audits/auditForms';
import { KQL_OUTCOME, KQL_STATUS } from './labels';
import KbAttestation from './KbAttestation';

interface OverviewTabProps {
    isMobile?: boolean;
    navigate?: (section: string, id?: string | null) => void;
    onNavigate?: (path: string) => void;
}

/**
 * The review itself lives on the knowledge base (its managers judge the answers; compliance sees counts).
 * The link goes there; whether the log opens is decided by the caller's rights on that base, not here.
 */
function OpenSearchLog({ k, onNavigate }: { k: KqlKbRow; onNavigate?: ((path: string) => void) | undefined }) {
    const { t } = useTranslation();
    if (!onNavigate) return null;
    return (
        <button
            type="button"
            className="self-start text-[11px] underline text-[var(--accent-primary)]"
            onClick={() => onNavigate(`studio/knowledge/${encodeURIComponent(k.id)}/search-log`)}
            data-testid={`kql-open-kb-${k.id}`}
        >
            {t('compliance.kql_open_kb_log', 'Open the search log on the knowledge base')}
        </button>
    );
}

function CountList({ counts, table }: { counts: Record<string, number>; table: typeof KQL_OUTCOME }) {
    const { t } = useTranslation();
    const entries = Object.entries(counts).filter(([, n]) => n > 0);
    if (!entries.length) return <span className="text-[var(--text-tertiary)]">—</span>;
    return (
        <span className="flex flex-col gap-0.5 text-[11px] text-[var(--text-secondary)] tabular-nums">
            {entries.map(([k, n]) => <span key={k}>{labelOf(t, table, k)}: {n}</span>)}
        </span>
    );
}

function overviewColumns(t: TranslateFn): TableColumn[] {
    return [
        { id: 'kb', width: '1.2fr', label: t('compliance.kql_col_kb', 'Knowledge base') },
        { id: 'logging', width: '110px', label: t('compliance.kql_col_logging', 'Logging') },
        { id: 'retention', width: '100px', label: t('compliance.kql_col_retention', 'Kept for'), foldBelow: 900 },
        { id: 'changed', width: '1fr', label: t('compliance.kql_col_changed', 'Last changed'), foldBelow: 1180 },
        { id: 'managers', width: '1fr', label: t('compliance.kql_col_managers', 'Managers'), foldBelow: 1180 },
        { id: 'attestation', width: '1.3fr', label: t('compliance.kql_col_attestation', 'Attestation'), foldBelow: 1100 },
        { id: 'acknowledged', width: '110px', label: t('compliance.kql_col_acknowledged', 'Acknowledged by'), foldBelow: 1000 },
        { id: 'outcomes', width: '140px', label: t('compliance.kql_col_outcomes', 'Outcomes') },
        { id: 'statuses', width: '140px', label: t('compliance.kql_col_statuses', 'Review status') },
    ];
}

/** The facts of one knowledge base as words, shared by the row and the phone card. */
function useKbFacts(k: KqlKbRow) {
    const { t, resolvedLocale } = useTranslation();
    return {
        t,
        locale: resolvedLocale,
        changed: k.changedAt ? t('compliance.kql_changed', '{when} by {who}', { when: fmtStamp(k.changedAt, resolvedLocale), who: k.changedByName || k.changedBy || '—' }) : '—',
        managers: k.managers.map((m) => m.name || m.id).join(', ') || '—',
        retention: k.retentionDays === null ? '—' : t('compliance.kql_days', '{n} days', { n: k.retentionDays }),
        pill: (
            <StatusPill tone={k.enabled ? 'success' : 'neutral'} testId={`kql-logging-${k.id}`}>
                {k.enabled ? t('compliance.kql_logging_on', 'On') : t('compliance.kql_logging_off', 'Off')}
            </StatusPill>
        ),
    };
}

function KbRow({ k, columns, onNavigate }: { k: KqlKbRow; columns: TableColumn[]; onNavigate?: ((path: string) => void) | undefined }) {
    const f = useKbFacts(k);
    return (
        <TableRow columns={columns} testId={`kql-kb-${k.id}`}>
            <TableCell column={columns[0]}>
                <span className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-medium truncate">{k.name}</span>
                    <OpenSearchLog k={k} onNavigate={onNavigate} />
                </span>
            </TableCell>
            <TableCell column={columns[1]}>{f.pill}</TableCell>
            <TableCell column={columns[2]}><span className="text-[var(--text-secondary)]">{f.retention}</span></TableCell>
            <TableCell column={columns[3]}><span className="text-[var(--text-secondary)] [overflow-wrap:anywhere]">{f.changed}</span></TableCell>
            <TableCell column={columns[4]}><span className="text-[var(--text-secondary)] [overflow-wrap:anywhere]">{f.managers}</span></TableCell>
            <TableCell column={columns[5]}><KbAttestation t={f.t} k={k} locale={f.locale} /></TableCell>
            <TableCell column={columns[6]}>
                <span className="tabular-nums" data-testid={`kql-ack-${k.id}`}>{f.t('compliance.kql_ack_users', '{n} users', { n: k.acknowledgedUsers })}</span>
            </TableCell>
            <TableCell column={columns[7]}>
                <span className="flex flex-col gap-0.5">
                    <span className="tabular-nums font-medium" data-testid={`kql-total-${k.id}`}>{k.total}</span>
                    <CountList counts={k.byOutcome} table={KQL_OUTCOME} />
                </span>
            </TableCell>
            <TableCell column={columns[8]}><CountList counts={k.byStatus} table={KQL_STATUS} /></TableCell>
        </TableRow>
    );
}

function KbCard({ k, onNavigate }: { k: KqlKbRow; onNavigate?: ((path: string) => void) | undefined }) {
    const f = useKbFacts(k);
    return (
        <div className="flex flex-col gap-1 min-w-0" data-testid={`kql-kb-card-${k.id}`}>
            <span className="flex items-center gap-2"><span className="text-xs font-semibold truncate">{k.name}</span>{f.pill}</span>
            <span className="text-[11px] text-[var(--text-secondary)]">{f.retention} · {f.changed}</span>
            <span className="text-[11px] text-[var(--text-secondary)]">{f.t('compliance.kql_col_managers', 'Managers')}: {f.managers}</span>
            <KbAttestation t={f.t} k={k} locale={f.locale} />
            <span className="text-[11px] tabular-nums">{f.t('compliance.kql_ack_users', '{n} users', { n: k.acknowledgedUsers })}</span>
            <span className="text-[11px] tabular-nums">{f.t('compliance.kql_entries_count', '{n} entries', { n: k.total })}</span>
            <CountList counts={k.byOutcome} table={KQL_OUTCOME} />
            <CountList counts={k.byStatus} table={KQL_STATUS} />
            <OpenSearchLog k={k} onNavigate={onNavigate} />
        </div>
    );
}

/** Per knowledge base: is the log on, for how long, who set it, and how many rows it holds. Never a question or an answer. */
export default function OverviewTab({ isMobile = false, navigate, onNavigate }: OverviewTabProps) {
    const { t, resolvedLocale } = useTranslation();
    const q = useKbQueryLogOverviewQuery();
    const overview = q.data ?? null;

    const openAudit = () => {
        presetAccessAuditActions(KQL_AUDIT_ACTIONS);
        navigate?.('access_log');
    };

    if (q.isError) {
        return (
            <div className="p-3.5" data-testid="kql-overview-failed">
                <ReadFailed>{t('compliance.kql_read_failed', 'The query log overview could not be read.')}</ReadFailed>
            </div>
        );
    }

    const columns = overviewColumns(t);
    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="kql-overview"
            toolbar={(
                <>
                    <Intro testId="kql-overview-intro">
                        {t('compliance.kql_overview_intro', 'Which knowledge bases keep a log of what people searched for and were answered, for how long, and who decided it. This overview shows counts only: what people asked is never shown here.')}
                    </Intro>
                    <ActionButton icon={History} onClick={openAudit} data-testid="kql-open-audit">
                        {t('compliance.kql_open_audit', 'Changes in the access log')}
                    </ActionButton>
                </>
            )}
        >
            {overview && !overview.licensed && (
                <ReadFailed testId="kql-unlicensed">
                    {t('compliance.kql_unlicensed', 'The licence for the query log has ended: nothing new is logged. Existing entries stay until their term runs out and can still be exported or erased.')}
                </ReadFailed>
            )}
            <DataTable
                columns={columns}
                rows={overview?.kbs ?? []}
                loading={overview === null}
                isMobile={isMobile}
                rowKey={(k: KqlKbRow) => k.id}
                ariaLabel={t('compliance.kql_overview_title', 'Query log per knowledge base')}
                testId="kql-overview-table"
                empty={(
                    <EmptyState
                        title={t('compliance.kql_overview_empty_title', 'No knowledge base logs searches')}
                        description={t('compliance.kql_overview_empty_sub', 'A knowledge base manager can switch the log on in the knowledge base settings. Until then nothing is recorded.')}
                    />
                )}
                renderRow={(k: KqlKbRow, ctx) => <KbRow k={k} columns={ctx.columns} onNavigate={onNavigate} />}
                renderCard={(k: KqlKbRow) => <KbCard k={k} onNavigate={onNavigate} />}
            />
        </RegisterLayout>
    );
}

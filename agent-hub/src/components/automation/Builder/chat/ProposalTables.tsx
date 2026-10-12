import { Table2 } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import type { PendingTable, UsedTable } from './pendingTables';

interface ProposalTablesProps {
    proposal: { pendingDatatables?: PendingTable[]; usedDatatables?: UsedTable[] } | null | undefined;
}

/**
 * The tables a proposal brings: the NEW ones (name and columns, created only
 * when the user presses Apply) and the existing ones its steps use. Showing the
 * columns here is what makes Apply an informed choice, as a table is the one
 * thing in a proposal that outlives an Undo.
 */
export default function ProposalTables({ proposal }: ProposalTablesProps) {
    const { t } = useTranslation();
    const pending = Array.isArray(proposal?.pendingDatatables) ? proposal.pendingDatatables : [];
    const used = Array.isArray(proposal?.usedDatatables) ? proposal.usedDatatables : [];
    const existing = used.filter(u => !u.pending);
    if (!pending.length && !existing.length) return null;
    const usedRefs = new Set(used.map(u => u.id));
    return <div className="space-y-2" data-testid="proposal-tables">
        {pending.length > 0 && <section aria-label={t('automations.assistant.new_tables', 'New tables')} className="space-y-1.5">
            <h4 className="font-semibold text-[var(--text-secondary)]">{t('automations.assistant.new_tables', 'New tables')}</h4>
            {pending.map(table => <div key={table.ref} className="rounded-lg bg-[var(--bg-secondary)] p-2" data-testid="proposal-new-table">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Table2 size={12} className="shrink-0 text-[var(--type-ai)]" aria-hidden="true" />
                    <span className="min-w-0 break-words font-medium">{table.name}</span>
                    {table.scope && <span className="text-[var(--text-tertiary)]">{table.scope === 'org' ? t('automations.assistant.table_scope_org', 'Organisation table') : t('automations.assistant.table_scope_personal', 'Personal table')}</span>}
                </div>
                {table.fields?.length > 0 && <ul className="mt-1.5 flex flex-wrap gap-1">
                    {table.fields.map(field => <li key={field.key} title={Array.isArray(field.options) && field.options.length ? field.options.join(', ') : undefined} className="rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] px-1.5 py-0.5 text-[11px]">{field.name} · {field.type}</li>)}
                </ul>}
                <p className="mt-1.5 text-[var(--type-ai)]">{t('automations.assistant.table_created_on_apply', 'Created when you press Apply')}</p>
                {!usedRefs.has(table.ref) && <p className="text-[var(--text-tertiary)]">{t('automations.assistant.table_not_used', 'Not used by a step yet')}</p>}
            </div>)}
        </section>}
        {existing.length > 0 && <section aria-label={t('automations.assistant.tables_used', 'Tables used')} className="space-y-1">
            <h4 className="font-semibold text-[var(--text-secondary)]">{t('automations.assistant.tables_used', 'Tables used')}</h4>
            <ul className="space-y-1">
                {existing.map(table => <li key={table.id} className="flex flex-wrap items-center gap-x-2" data-testid="proposal-used-table">
                    <Table2 size={12} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    <span className="min-w-0 break-words font-medium">{table.name}</span>
                    <span className="text-[var(--text-tertiary)]">{t('automations.assistant.table_existing', 'existing')}</span>
                    {table.newlyBound && <span className="rounded-md bg-[color-mix(in_srgb,var(--type-ai)_12%,transparent)] px-1.5 py-0.5 text-[11px] text-[var(--type-ai)]">{t('automations.assistant.table_newly_linked', 'newly linked')}</span>}
                </li>)}
            </ul>
        </section>}
    </div>;
}

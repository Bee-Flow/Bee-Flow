import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { RunStartedBy } from './runsApi';

/**
 * What started a run that a record trigger started: the event, the table, the row's id and the
 * kind of writer. The run log keeps no row values, so none are shown; the server leaves the
 * line out once the change is past its retention.
 */

function eventText(event: string, t: TranslateFn): string {
    if (event === 'create') return t('studio_apps_h4.runs.event_create', 'Row added');
    if (event === 'update') return t('studio_apps_h4.runs.event_update', 'Row changed');
    if (event === 'delete') return t('studio_apps_h4.runs.event_delete', 'Row deleted');
    return event;
}

function writerText(by: string, t: TranslateFn): string {
    if (by === 'member') return t('studio_apps_h4.runs.by_member', 'by a member');
    if (by === 'owner') return t('studio_apps_h4.runs.by_owner', 'by the owner');
    if (by === 'public') return t('studio_apps_h4.runs.by_public', 'by a visitor');
    if (by === 'trigger') return t('studio_apps_h4.runs.by_trigger', 'by another trigger');
    return '';
}

export default function RunStartedByLine({ startedBy }: { startedBy: RunStartedBy }) {
    const { t } = useTranslation();
    if (startedBy.kind !== 'record') return null;
    const by = writerText(startedBy.by, t);
    return (
        <p className="text-[var(--text-secondary)]" data-testid="run-started-by">
            {t('studio_apps_h4.runs.started_by', 'Started by: {event} in {table}, row {row}', { event: eventText(startedBy.event, t), table: startedBy.tableId, row: startedBy.rowId })}
            {by ? ` (${by})` : ''}
        </p>
    );
}

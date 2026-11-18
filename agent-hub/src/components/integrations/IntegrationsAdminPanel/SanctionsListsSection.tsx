// "Sanctions lists" section of Platform services: the official lists this server imports
// (EU, UN, Dutch, OFAC, UK), per list its last refresh, number of entries and last error,
// and "Refresh now". Organisations switch the integration on themselves; the screening
// runs on this server against these copies.
import { RefreshCw } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { useLocaleFormat } from '@/hooks/useLocaleFormat';
import { CHIP, CHIP_SUCCESS, CHIP_WARNING, PRIMARY_BTN } from '@/components/mcpLibrary/ui';
import Spinner from '@/components/shared/Spinner';
import { useRefreshSanctionsLists, useSanctionsListStatus, type SanctionsListStatus } from '@/api/queries/sanctionsLists';

function StatusChip({ list }: { list: SanctionsListStatus }) {
    const { t } = useTranslation();
    if (list.status === 'ok') return <span className={CHIP_SUCCESS}>{t('sanctions.status_ok', 'Up to date')}</span>;
    if (list.status === 'error') return <span className={CHIP_WARNING}>{t('sanctions.status_error', 'Last refresh failed')}</span>;
    return <span className={CHIP}>{t('sanctions.status_never', 'Not imported yet')}</span>;
}

function ListRow({ list }: { list: SanctionsListStatus }) {
    const { t } = useTranslation();
    const fmt = useLocaleFormat();
    return (
        <li className="flex flex-col gap-1 border-b border-[var(--border-subtle)] py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-2">
                <a href={list.infoUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-[var(--text-primary)] underline-offset-2 hover:underline">
                    {list.label}
                </a>
                <StatusChip list={list} />
            </div>
            <p className="m-0 text-xs text-[var(--text-secondary)]">{list.publisher}</p>
            <p className="m-0 text-xs text-[var(--text-secondary)]">
                {t('sanctions.entries', '{count} entries', { count: list.entityCount })}
                {' · '}
                {list.lastSuccessAt
                    ? t('sanctions.last_success', 'Last checked {when}', { when: fmt.dateTime(list.lastSuccessAt) })
                    : t('sanctions.no_success', 'Never refreshed successfully')}
            </p>
            {list.status === 'error' && list.lastError && (
                <p className="m-0 text-xs text-[var(--error)]">{t('sanctions.last_error', 'Last error: {error}', { error: list.lastError })}</p>
            )}
        </li>
    );
}

export default function SanctionsListsSection() {
    const { t } = useTranslation();
    const status = useSanctionsListStatus();
    const refresh = useRefreshSanctionsLists();
    const refreshing = !!status.data?.refreshing || refresh.isPending;

    if (status.isLoading) {
        return <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]"><Spinner size="sm" /> {t('sanctions.loading', 'Loading the sanctions lists...')}</div>;
    }
    if (status.isError || !status.data) {
        return <p className="text-sm text-[var(--error)]">{t('sanctions.load_failed', 'The status of the sanctions lists could not be loaded.')}</p>;
    }
    const { lists, intervalHours, pepFunctionsVersion } = status.data;
    return (
        <section aria-label={t('sanctions.title', 'Sanctions lists')} className="flex max-w-3xl flex-col gap-4">
            <p className="m-0 text-sm text-[var(--text-secondary)]">
                {t('sanctions.intro', 'This server keeps its own copy of the official sanctions lists. Screening runs here against that copy: names never leave the server. Organisations switch the Sanctions lists integration on themselves.')}
            </p>
            <div className="flex flex-wrap items-center gap-3">
                <button type="button" className={PRIMARY_BTN} disabled={refreshing} onClick={() => refresh.mutate()}>
                    {refreshing ? <Spinner size="sm" /> : <RefreshCw aria-hidden="true" className="h-4 w-4" />}
                    <span className="ml-1">{refreshing ? t('sanctions.refreshing', 'Refreshing...') : t('sanctions.refresh_now', 'Refresh now')}</span>
                </button>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {intervalHours > 0
                        ? t('sanctions.interval', 'Refreshed every {hours} hours while an organisation uses the lists.', { hours: intervalHours })
                        : t('sanctions.interval_off', 'Automatic refresh is off on this server (SANCTIONS_REFRESH_INTERVAL_HOURS=0).')}
                </span>
            </div>
            {refresh.isError && <p className="m-0 text-sm text-[var(--error)]">{t('sanctions.refresh_failed', 'The refresh could not be started.')}</p>}
            <ul className="m-0 list-none p-0">
                {lists.map((list) => <ListRow key={list.id} list={list} />)}
            </ul>
            <p className="m-0 text-xs text-[var(--text-tertiary)]">
                {t('sanctions.pep_version', 'PEP function lists (Dutch and EU) bundled with this version: {version}.', { version: pepFunctionsVersion })}
            </p>
        </section>
    );
}

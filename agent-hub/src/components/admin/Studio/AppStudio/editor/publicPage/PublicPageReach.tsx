import { Globe, Loader2 } from 'lucide-react';
import { useMemo } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppDefinition } from '../../inspector/appDefinition';
import { describeAction } from '../../inspector/actionLabels';
import useAppRoles from '../../rbac/useAppRoles';
import { grantPhrase, joinNames } from '../publishAccessSummary';
import { publicReach, publicTableGrants } from './publicPageModel';
import type { PublicAccess } from './publicPageModel';

/**
 * What an anonymous visitor with the link can reach, read from the draft:
 * the listed screens, the actions wired on them (and the ones those call),
 * and the tables that grant the reserved `public` role something. Tables are
 * read from the saved data model, as the audience summary reads them; the
 * public role inherits nothing from a table's default, so a table missing
 * here is closed to visitors.
 */
export default function PublicPageReach({ t, appId, definition, pa }: { t: TranslateFn; appId: string; definition: AppDefinition; pa: PublicAccess }) {
    const reach = useMemo(() => publicReach(definition, pa), [definition, pa]);
    const actions = definition.actions || {};
    const label = (id: string) => describeAction(id, actions[id], definition, null, t);
    return (
        <div data-testid="public-page-reach" className="space-y-1.5 rounded-lg border px-3 py-2.5 text-xs border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-secondary)]">
            <p className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                {t('studio_apps_public.reach.title', 'Anyone with the link, without an account, can reach:')}
            </p>
            <p>
                {t('studio_apps_public.reach.screens', 'Screens: {names}.', {
                    names: joinNames(reach.screens.map((s) => (s.entry ? t('studio_apps_public.reach.entry_name', '{name} (entry)', { name: s.name }) : s.name)), t),
                })}
            </p>
            <p>
                {reach.actions.length
                    ? t('studio_apps_public.reach.actions', 'What the buttons and forms on those screens do: {names}.', { names: joinNames(reach.actions.map(label), t) })
                    : t('studio_apps_public.reach.no_actions', 'Nothing on those screens runs an action.')}
            </p>
            {reach.calledActions.length ? (
                <p>{t('studio_apps_public.reach.called', 'Those also run, as part of them: {names}.', { names: joinNames(reach.calledActions.map(label), t) })}</p>
            ) : null}
            <TableReach t={t} appId={appId} />
            <p className="text-[var(--text-tertiary)]">{t('studio_apps_public.reach.rest_closed', 'Everything else stays closed: the other screens, the navigation, the other actions and the app’s outside sources.')}</p>
        </div>
    );
}

function TableReach({ t, appId }: { t: TranslateFn; appId: string }) {
    const { tables, isLoading, isError, hasModel } = useAppRoles(appId);
    if (isLoading) {
        return <p className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />{t('studio_apps_public.reach.tables_loading', 'Checking the tables…')}</p>;
    }
    if (isError) return <p>{t('studio_apps_public.reach.tables_error', 'The tables could not be checked. Open “Roles & access” to see what the public role may do.')}</p>;
    const grants = hasModel ? publicTableGrants(tables) : [];
    if (grants.length === 0) {
        return <p>{t('studio_apps_public.reach.tables_none', 'Tables: none. No table grants the public role anything, so a visitor can neither read nor save rows.')}</p>;
    }
    return (
        <>
            {grants.map(({ table, grant }) => (
                <p key={table.id || table.key || table.name}>
                    {t('studio_apps_public.reach.table', 'In {name}, a visitor can {phrase}.', {
                        name: table.name || table.key || table.id || '',
                        phrase: grantPhrase(grant, t) || '',
                    })}
                </p>
            ))}
        </>
    );
}

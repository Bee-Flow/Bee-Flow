// The server-wide items of a sub-navigation that mixes scopes (Security, the
// Users screen, Agents, Access): placed last, under a "Whole server" divider,
// each with the small server icon. Which items are server-wide comes from the
// scope data in adminTabs, never from a second list.

import { Server } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';

/** The small server icon after a server-wide item, with its accessible name. */
export function ServerWideMark() {
    const { t } = useTranslation();
    const label = t('admin.scope_instance', 'Whole server');
    // The space keeps the item's accessible name two words ("SSO Whole server").
    return (
        <>
            {' '}
            <span role="img" aria-label={label} title={label} className="ml-auto inline-flex shrink-0 text-[var(--warning-ink)]" data-testid="server-wide-mark">
                <Server className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
        </>
    );
}

/** The divider above the server-wide part of a page that mixes scopes. */
export function ServerWideDivider() {
    const { t } = useTranslation();
    return (
        <h3 className="m-0 flex items-center gap-1.5 border-t border-[color-mix(in_srgb,var(--warning)_40%,transparent)] pt-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--warning-ink)]">
            <Server className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('admin.scope_instance', 'Whole server')}
        </h3>
    );
}

/**
 * The items in their order with the server-wide ones moved last (each keeps its
 * relative order); `serverWide` marks them and `startsServerGroup` the first one.
 */
export function serverWideLast<T extends object>(items: readonly T[], isServerWide: (item: T) => boolean): (T & { serverWide: boolean; startsServerGroup: boolean })[] {
    const own = items.filter(item => !isServerWide(item)).map(item => ({ ...item, serverWide: false, startsServerGroup: false }));
    const server = items.filter(isServerWide).map((item, i) => ({ ...item, serverWide: true, startsServerGroup: i === 0 }));
    return [...own, ...server];
}

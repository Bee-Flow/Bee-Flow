/** The automation list's search and status filter, as pure functions. */

import type { Automation } from './types';

export type AutomationFilter = 'all' | 'active' | 'paused' | 'failing';

export const AUTOMATION_FILTERS: { value: AutomationFilter; i18nKey: string; en: string }[] = [
    { value: 'all', i18nKey: 'common.all', en: 'All' },
    { value: 'active', i18nKey: 'common.on', en: 'On' },
    { value: 'paused', i18nKey: 'automations.paused', en: 'Paused' },
    { value: 'failing', i18nKey: 'studio_misc.overview.last_run_failed', en: 'Last run failed' },
];

function matchesFilter(item: Automation, filter: AutomationFilter): boolean {
    switch (filter) {
        case 'active':
            return item.isActive;
        case 'paused':
            return !item.isActive;
        case 'failing':
            // 'failed' is the runner's own word on the automation row; the
            // run table says 'error'. Both mean the same thing here.
            return item.lastStatus === 'error' || item.lastStatus === 'failed';
        default:
            return true;
    }
}

export function filterAutomations(items: Automation[], search: string, filter: AutomationFilter): Automation[] {
    const needle = search.trim().toLowerCase();
    return items.filter((item) => {
        if (needle) {
            const haystack = `${item.title ?? ''} ${item.description ?? ''}`.toLowerCase();
            if (!haystack.includes(needle)) return false;
        }
        return matchesFilter(item, filter);
    });
}

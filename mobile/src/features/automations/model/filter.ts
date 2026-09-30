/** The automation list's search and status filter, as pure functions. */

import type { Automation } from './types';

export type AutomationFilter = 'all' | 'active' | 'paused' | 'failing';

export const AUTOMATION_FILTERS: { value: AutomationFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'On' },
    { value: 'paused', label: 'Paused' },
    { value: 'failing', label: 'Last run failed' },
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

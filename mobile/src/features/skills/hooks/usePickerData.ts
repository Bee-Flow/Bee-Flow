/**
 * The three lists every picker in the skill editor needs — automations an agent
 * can call, knowledge bases, tables — read independently, so one list that
 * falls over does not take the others (or the editor) down.
 *
 * Each read has three answers, as the web's useSkillPickerData has: not yet
 * (`loaded: false`), could not (named in `unavailable`), and the rows. A
 * `reload()` re-asks all three, because a single 500 should not stand until
 * the screen is reopened.
 */

import { useQuery } from '@tanstack/react-query';

import { skillKeys } from '../api/keys';
import { listAgentKnowledgeBases, listCallableAutomations, listTables, type PickerItem } from '../api/pickers';

export type PickerList = 'automations' | 'kbs' | 'tables';

export interface PickerData {
    automations: PickerItem[];
    kbs: PickerItem[];
    tables: PickerItem[];
    loaded: boolean;
    unavailable: PickerList[];
    reload: () => void;
}

const FETCH: Record<PickerList, () => Promise<PickerItem[] | null>> = {
    automations: listCallableAutomations,
    kbs: listAgentKnowledgeBases,
    tables: listTables,
};

function usePickerList(list: PickerList, enabled: boolean) {
    return useQuery({
        queryKey: skillKeys.picker(list),
        queryFn: FETCH[list],
        enabled,
        staleTime: 60_000,
    });
}

export function usePickerData(enabled = true): PickerData {
    const automations = usePickerList('automations', enabled);
    const kbs = usePickerList('kbs', enabled);
    const tables = usePickerList('tables', enabled);
    const reads = { automations, kbs, tables };
    const lists = Object.keys(reads) as PickerList[];
    return {
        automations: automations.data ?? [],
        kbs: kbs.data ?? [],
        tables: tables.data ?? [],
        loaded: lists.every((l) => reads[l].data !== undefined),
        unavailable: lists.filter((l) => reads[l].data === null),
        reload: () => {
            for (const l of lists) void reads[l].refetch();
        },
    };
}

/** The label a reference shows: the referenced thing's name, or its bare id. */
export function pickerName(items: readonly PickerItem[], id: string): string {
    return items.find((i) => i.id === id)?.name || id;
}

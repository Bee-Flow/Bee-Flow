/**
 * The items of the "+ reference" menu — the web's RefMenu, as ActionMenu rows.
 *
 * A reference is a GRANT (a `table` ref joins the agent's query allowlist for
 * the conversation), so the menu says exactly one of: still asking, which
 * lists could not be read (with a retry), nothing to reference — or the rows.
 * A reference the step already carries is not offered twice.
 */

import type { TranslateFn } from '@/core/i18n';
import type { ActionMenuItem, IconName } from '@/shared/ui';

import type { PickerData, PickerList } from '../hooks/usePickerData';
import type { RefKind, StepRef } from '../model/types';

export const REF_ICON: Readonly<Record<RefKind, IconName>> = { automation: 'Workflow', kb: 'BookOpen', table: 'Table' };

const GROUPS: readonly { kind: RefKind; list: PickerList }[] = [
    { kind: 'automation', list: 'routines' },
    { kind: 'kb', list: 'kbs' },
    { kind: 'table', list: 'tables' },
];

export function refGroupName(t: TranslateFn, kind: RefKind): string {
    if (kind === 'automation') return t('skills_studio.ref.automations', 'Routines');
    if (kind === 'kb') return t('skills_studio.ref.kbs', 'Knowledge bases');
    return t('skills_studio.ref.tables', 'Tables');
}

const noop = () => undefined;

export function refMenuItems(
    t: TranslateFn,
    picker: PickerData,
    taken: readonly StepRef[],
    onPick: (ref: StepRef) => void,
): ActionMenuItem[] {
    if (!picker.loaded) return [{ id: 'loading', label: t('skills_studio.ref.loading', 'Loading…'), disabled: true, onPress: noop }];
    const has = (kind: RefKind, id: string) => taken.some((r) => r.kind === kind && r.id === id);
    const rows: ActionMenuItem[] = [];
    for (const { kind, list } of GROUPS) {
        for (const item of picker[list]) {
            if (has(kind, item.id)) continue;
            rows.push({ id: `${kind}:${item.id}`, label: item.name, icon: REF_ICON[kind], onPress: () => onPick({ kind, id: item.id }) });
        }
    }
    const missing = GROUPS.filter((g) => picker.unavailable.includes(g.list)).map((g) => refGroupName(t, g.kind));
    const head: ActionMenuItem[] = [];
    if (missing.length > 0) {
        head.push({
            id: 'unread',
            label: t('skills_studio.ref.unread', 'Could not be read: {lists}. That is not “you have none”.', { lists: missing.join(', ') }),
            icon: 'TriangleAlert',
            onPress: picker.reload,
        });
    } else if (rows.length === 0) {
        head.push({ id: 'none', label: t('skills_studio.ref.none', 'Nothing to reference yet.'), disabled: true, onPress: noop });
    }
    return [...head, ...rows];
}

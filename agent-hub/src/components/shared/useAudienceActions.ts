import useConfirm from './useConfirm';
import type { TranslateFn, TranslateParams } from '../../hooks/useTranslation';
import type { AudienceActionsOptions } from './VisibilityCapsule.types';

export const PERSONAL = 'personal';

export const ORG = 'org';

export const GROUPS = 'groups';

/**
 * t() with the placeholders filled in afterwards as well. The real translator
 * interpolates `{name}` itself; a caller-supplied `t` (tests, embeds) may not,
 * and a capsule reading "{count} groups" is worse than no capsule.
 */
export function tx(t: TranslateFn, key: string, fallback: string, params?: TranslateParams): string {
    let value = t(key, fallback, params);
    if (typeof value !== 'string') value = fallback;
    for (const [k, v] of Object.entries(params || {})) {
        value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return value;
}

/**
 * The three transitions, with the widening rule applied. Shared by the
 * capsule and AudienceRows so the rule lives once. Returns synchronous
 * callbacks when nothing needs asking (existing consumers close their menu
 * inside the callback and expect it to have fired by the time the click
 * handler returns); only a real question goes through the promise.
 */
export function useAudienceActions({
    t, entity, mode, sharedGroups, nameOf, confirmWidening,
    onSetPersonal, onSetEntireOrg, onToggleGroup,
    // Optional: what to do when the LAST group is unticked. Default is
    // `onSetPersonal` (see toggleGroup); a consumer whose list lives inside
    // a popover hands in a refusal instead, because onSetPersonal closes it.
    onLastGroup = null,
}: AudienceActionsOptions) {
    const { confirm, confirmDialog } = useConfirm();
    const subject = (entity && (entity.name || entity.title)) || t('visibility.this_item', 'this item');

    const ask = (description: string) => confirm({
        title: t('visibility.confirm_title', 'Share more widely?'),
        description,
        confirmLabel: t('visibility.confirm_share', 'Share'),
        cancelLabel: t('visibility.confirm_keep', 'Keep as is'),
    });

    // Narrowing never asks.
    const choosePersonal = () => { onSetPersonal?.(); };

    const chooseOrg = () => {
        // Personal → org and groups → org both hand access to people who did
        // not have it; org → org is a no-op re-select and just reports back.
        if (!confirmWidening || mode === ORG) { onSetEntireOrg?.(); return; }
        ask(tx(t, 'visibility.confirm_org', 'Everyone in your organisation will be able to see and use “{name}”.', { name: subject }))
            .then((ok) => { if (ok) onSetEntireOrg?.(); });
    };

    const toggleGroup = (gid: string) => {
        const current = Array.isArray(sharedGroups) ? sharedGroups : [];
        const adding = !current.includes(gid);
        // Unticking the last group: `[]` on a published thing means EVERYONE,
        // so the honest reading of "no groups" is personal — unless the
        // consumer asked to be told instead (the capsule refuses the untick).
        if (!adding && mode === GROUPS && current.length === 1) {
            if (onLastGroup) onLastGroup(); else onSetPersonal?.();
            return;
        }
        // Leaving personal is the widening; ticking a group while the whole
        // org can already see it is a narrowing, and so is unticking.
        if (!confirmWidening || !adding || mode !== PERSONAL) { onToggleGroup?.(gid); return; }
        const groups = nameOf ? nameOf(gid) : gid;
        ask(tx(t, 'visibility.confirm_groups', 'Members of {groups} will be able to see and use “{name}”.', { groups, name: subject }))
            .then((ok) => { if (ok) onToggleGroup?.(gid); });
    };

    return { choosePersonal, chooseOrg, toggleGroup, confirmDialog };
}

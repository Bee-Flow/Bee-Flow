/**
 * The ONE "New" menu, as data — the web's buildNewMenuModel
 * (components/admin/Studio/NewMenu.jsx). Derived, not authored: an item per
 * section that declares a `create`, filed under its category heading, in the
 * registry's order, so the menu and the Studio rows cannot drift. A locked
 * section's item is listed locked with the same hint, so a Community org
 * learns what an App is instead of never hearing of it.
 *
 * The phone draws a heading where the web draws a divider: a bottom sheet has
 * room for one, and "Build / AI / Bundle" is how people navigate it.
 */

import type { LockReason } from '@/core/access';
import type { IconName, KindKey } from '@/shared/ui';

import { groupSections } from './resolve';
import type { ResolvedSection, StudioCategory, StudioTarget } from './types';

export type NewMenuEntry =
    | { type: 'ai'; id: 'ai'; labelKey: string; labelFallback: string }
    | { type: 'heading'; id: string; category: StudioCategory }
    | {
          type: 'item';
          id: string;
          labelKey: string;
          labelFallback: string;
          kind: KindKey | null;
          icon: IconName;
          locked: LockReason | null;
          target: StudioTarget;
      };

/**
 * "Describe it — AI picks the building blocks": opens the building-block
 * picker (components/DescribeItSheet, the web's DescribeItPanel), which the
 * host hands the menu as `onDescribe` — as the web's Studio header hands its
 * NewMenu an `onAi`. Not locked here: the picker itself offers only the kinds
 * this person may make, and shows a locked one as a notice.
 */
const AI_ENTRY: NewMenuEntry = {
    type: 'ai',
    id: 'ai',
    labelKey: 'studio.new.ai',
    labelFallback: 'Describe it — AI picks the building blocks',
};

export function buildNewMenu(sections: readonly ResolvedSection[]): NewMenuEntry[] {
    const model: NewMenuEntry[] = [AI_ENTRY];
    for (const { category, sections: inGroup } of groupSections(sections)) {
        const items = inGroup.filter((s) => s.create);
        if (!items.length) continue;
        model.push({ type: 'heading', id: `heading-${category.id}`, category });
        for (const s of items) {
            const create = s.create as NonNullable<ResolvedSection['create']>;
            model.push({
                type: 'item',
                id: s.id,
                labelKey: create.labelKey,
                labelFallback: create.labelFallback,
                kind: s.kind,
                icon: s.icon,
                locked: s.locked,
                target: create.target,
            });
        }
    }
    return model;
}

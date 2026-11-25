/** Work of someone else that is shared with the caller: the line a row says, and what the role allows. */

import type { TranslateFn } from '@/core/i18n';

import type { SharedItem, SharedView } from './types';

function ownerOf(name: string | undefined, t: TranslateFn): string {
    return name?.trim() || t('cowork_mobile.shared.unknown_owner', 'A colleague');
}

/** "Ann's, you decide its questions" or "Ann's, you can see it". */
export function sharedLine(item: Pick<SharedItem, 'ownerName' | 'role'>, t: TranslateFn): string {
    const name = ownerOf(item.ownerName, t);
    return item.role === 'approver'
        ? t('cowork_mobile.shared.line_approver', '{name}’s, you decide its questions', { name })
        : t('cowork_mobile.shared.line_viewer', '{name}’s, you can see it', { name });
}

export function sharedRoute(id: string): string {
    return `/cowork/shared/${encodeURIComponent(id)}`;
}

/** A shared view is read only for everyone; this says so at the bottom of the screen. */
export function sharedFooter(view: Pick<SharedView, 'role'>, ownerName: string | undefined, t: TranslateFn): string {
    return view.role === 'owner'
        ? t('cowork_mobile.shared.read_only_owner', 'This is the read-only view of what you shared.')
        : t('cowork_mobile.shared.read_only', 'You can look along here. Changing it is up to {name}.', {
              name: ownerOf(ownerName, t),
          });
}

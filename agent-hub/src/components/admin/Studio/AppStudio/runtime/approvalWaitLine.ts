import type { WaitingFor } from '@/api/actionHttp';
import type { TranslateFn } from '@/hooks/useTranslation';

const NS = 'studio_apps_h2.tray';

/**
 * The line of a run on hold for an approval (the server's await_approval step): who decides.
 * Null when the server did not say, and the caller shows its plain "Waiting for an approval".
 */
export function approvalWaitLine(who: WaitingFor | undefined, t: TranslateFn): string | null {
    if (!who) return null;
    const named = 'name' in who && typeof who.name === 'string' && who.name ? who.name : null;
    const count = 'count' in who && typeof who.count === 'number' ? who.count : 0;
    switch (who.kind) {
        case 'user':
            return named ? t(`${NS}.by_person`, 'Waiting for approval by {name}', { name: named }) : t(`${NS}.by_someone`, 'Waiting for approval by the person asked');
        case 'group':
            return named ? t(`${NS}.by_group`, 'Waiting for approval by {name}', { name: named }) : t(`${NS}.by_a_group`, 'Waiting for approval by the group asked');
        case 'panel':
            return t(`${NS}.by_panel`, 'Waiting for approval by {count} approvers', { count });
        case 'stages':
            return t(`${NS}.by_stages`, 'Waiting for approval in {count} stages', { count });
        case 'owner':
            return t(`${NS}.by_owner`, 'Waiting for approval by the app owner');
        default:
            return null;
    }
}

import type { TranslateFn } from '../../../../hooks/useTranslation';

/**
 * The status of a routine in the words the builder header uses, so a row in
 * the library and the header of the open routine never disagree:
 *
 *   "Draft · never live"   no live version yet
 *   "Paused"               has a live version, switched off
 *   "Live · v3"            runs version 3
 *   "2 changes not live"   saved versions after the live one (a separate part,
 *                          so a row can colour it as a warning)
 *
 * Rows from a server that predates the live split carry no liveVersion; they
 * fall back on isDraft/isActive and say "Live" without a number.
 */

export type RoutineRole = 'owner' | 'edit' | 'view' | 'run';

export interface RoutineStatusInput {
    isActive?: boolean;
    isDraft?: boolean;
    liveVersion?: number | null;
    neverLive?: boolean;
    pendingChanges?: number;
    myRole?: string | null;
}

export type StatusTone = 'draft' | 'live' | 'paused' | 'pending';

export interface StatusPart {
    tone: StatusTone;
    text: string;
}

export function isNeverLive(r: RoutineStatusInput): boolean {
    if (typeof r.neverLive === 'boolean') return r.neverLive;
    if (r.liveVersion !== undefined) return r.liveVersion == null;
    return !!r.isDraft;
}

export function routineStatusParts(r: RoutineStatusInput, t: TranslateFn): StatusPart[] {
    if (isNeverLive(r)) {
        return [{ tone: 'draft', text: t('routines.status.draftNeverLive', 'Draft · never live') }];
    }
    const parts: StatusPart[] = [];
    if (!r.isActive) {
        parts.push({ tone: 'paused', text: t('routines.status.paused', 'Paused') });
    } else if (typeof r.liveVersion === 'number') {
        parts.push({ tone: 'live', text: t('routines.status.liveVersion', 'Live · v{version}', { version: r.liveVersion }) });
    } else {
        parts.push({ tone: 'live', text: t('routines.status.live', 'Live') });
    }
    const pending = Number(r.pendingChanges) || 0;
    if (pending > 0) {
        parts.push({
            tone: 'pending',
            text: pending === 1
                ? t('routines.status.oneChangeNotLive', '1 change not live')
                : t('routines.status.changesNotLive', '{count} changes not live', { count: pending }),
        });
    }
    return parts;
}

/** The caller's role on a routine; a row without one is the caller's own. */
export function roleOf(r: RoutineStatusInput): RoutineRole {
    const role = r.myRole;
    return role === 'edit' || role === 'view' || role === 'run' ? role : 'owner';
}

export function isSharedWithMe(r: RoutineStatusInput): boolean {
    return roleOf(r) !== 'owner';
}

export function roleLabel(role: RoutineRole, t: TranslateFn): string | null {
    if (role === 'run') return t('routines.role.canRun', 'Can run');
    if (role === 'view') return t('routines.role.canView', 'Can view');
    if (role === 'edit') return t('routines.role.canEdit', 'Can edit');
    return null;
}

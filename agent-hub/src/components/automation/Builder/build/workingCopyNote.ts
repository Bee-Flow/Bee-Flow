import { liveStateOf, type LiveRow } from '../header/liveState';

/**
 * Whether the assistant's changes land beside a version that runs are using:
 * the automation is switched on with a live version, so what is being edited
 * is the working copy and nothing changes for a run until "Make vN live".
 * False for a draft that never went live (there is only one copy), for a
 * paused automation (nothing runs on its own) and before the first save.
 */
export function editsBesideLiveVersion(row: LiveRow | null | undefined): boolean {
    return !!row && liveStateOf(row).kind === 'live';
}

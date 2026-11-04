import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import useAdjustOnChange from '../../hooks/useAdjustOnChange';

/** The section's own Studio route; `<base>/<id>` addresses one meeting. */
const STUDIO_PATH = 'studio/meeting-notes';

/**
 * Studio's New -> "Record or upload a meeting" lands on `<base>/new`: the cue
 * to open the capture flow, never a meeting id.
 */
const CAPTURE_CUE = 'new';

/** The meeting a route id addresses: none for no id and for the capture cue. */
function routeMeetingId(id: string | null | undefined): string | null {
    return id && id !== CAPTURE_CUE ? id : null;
}

function meetingPath(id: string | null): string {
    return id ? `${STUDIO_PATH}/${id}` : STUDIO_PATH;
}

export type MeetingNavigate = (href: string, options?: { replace?: boolean }) => void;

interface MeetingRouteSelectionArgs {
    /** The route's meeting id (`/app/studio/meeting-notes/<id>`), or the capture cue. */
    initialMeetingId: string | null;
    /** The SPA router; null when the page is mounted standalone. */
    onNavigate: MeetingNavigate | null;
    openCapture: () => unknown;
}

export interface MeetingRouteSelection {
    selectedId: string | null;
    /** Select a meeting (or none) and write it into the URL. */
    select: (id: string | null, options?: { replace?: boolean }) => void;
}

/**
 * The selected meeting, kept in step with the Studio route in both directions.
 *
 * Studio renders the page without a key, so it stays mounted while the route
 * changes: a later deep link (the sidebar's recents, the command palette,
 * browser back/forward) is adopted here, not only on mount. What the page
 * selects goes back into the URL, so a reload or a shared link opens the same
 * meeting, and never one that was just deleted. The capture cue opens the
 * recorder/upload dialog and is then replaced by the current selection's URL,
 * so a reload does not open the dialog again.
 */
export default function useMeetingRouteSelection({ initialMeetingId, onNavigate, openCapture }: MeetingRouteSelectionArgs): MeetingRouteSelection {
    const [selectedId, setSelectedId] = useState<string | null>(() => {
        // The global is the older handoff (set by a caller just before it
        // navigates; the demo still uses it); the route id is the current
        // one. The global wins because it is set for THIS mount and cleared
        // on read.
        if (typeof window !== 'undefined' && window.__beeflowPendingMeetingId) {
            const id = window.__beeflowPendingMeetingId;
            window.__beeflowPendingMeetingId = null;
            return id;
        }
        return routeMeetingId(initialMeetingId);
    });

    useAdjustOnChange([initialMeetingId], () => {
        if (initialMeetingId !== CAPTURE_CUE) setSelectedId(initialMeetingId || null);
    });

    const select = useCallback((id: string | null, { replace = false }: { replace?: boolean } = {}) => {
        setSelectedId(id);
        onNavigate?.(meetingPath(id), { replace });
    }, [onNavigate]);

    const takeCaptureCue = useEffectEvent(() => {
        openCapture();
        onNavigate?.(meetingPath(selectedId), { replace: true });
    });
    useEffect(() => {
        if (initialMeetingId === CAPTURE_CUE) takeCaptureCue();
    }, [initialMeetingId]);

    return { selectedId, select };
}

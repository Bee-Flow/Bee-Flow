import useContainerWidth from '../../../shared/useContainerWidth';

/**
 * useDrawerMode: where a register's SideDrawer goes, decided by the width the
 * register actually has rather than by the window.
 *
 *   modal    a phone: the drawer becomes a right-side dialog (SideDrawer's
 *            `modal` mode);
 *   inline   the drawer sits beside the table, but only while the table keeps
 *            at least `minTable` px next to it;
 *   overlay  otherwise: the drawer floats over the table behind a scrim
 *            (Escape, the scrim and the X close it, focus goes back to the
 *            row), so the table never collapses to a sliver at 1280 or 1024.
 *
 * The width is the observed width of the element the returned ref sits on
 * (the register's row that holds table and drawer), so a page inside a
 * narrower frame decides on ITS width. Until it is measured (first render,
 * jsdom), the mode is `inline`: the layout the pages had before.
 */
export type DrawerMode = 'modal' | 'inline' | 'overlay';

export interface DrawerModeOptions {
    isMobile?: boolean;
    /** The drawer's width in px (SideDrawer's default is 380). */
    drawerWidth?: number;
    /** The least width the table may keep beside an inline drawer. */
    minTable?: number;
    /** The gap between table and drawer (RegisterLayout's gap-3). */
    gap?: number;
}

export const DEFAULT_DRAWER_WIDTH = 380;
export const DEFAULT_MIN_TABLE = 640;
const DEFAULT_GAP = 12;

/** The pure rule, for a width that is already known (null = not measured yet). */
export function drawerModeFor(width: number | null, {
    isMobile = false,
    drawerWidth = DEFAULT_DRAWER_WIDTH,
    minTable = DEFAULT_MIN_TABLE,
    gap = DEFAULT_GAP,
}: DrawerModeOptions = {}): DrawerMode {
    if (isMobile) return 'modal';
    if (width === null || !(width > 0)) return 'inline';
    return width - drawerWidth - gap >= minTable ? 'inline' : 'overlay';
}

export default function useDrawerMode<T extends HTMLElement = HTMLDivElement>(
    options: DrawerModeOptions = {},
): [(node: T | null) => void, DrawerMode] {
    const [ref, width] = useContainerWidth<T>(!options.isMobile);
    return [ref, drawerModeFor(width, options)];
}

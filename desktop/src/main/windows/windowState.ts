/**
 * Remembering where a window was, and putting it back somewhere it can be seen.
 *
 * The second half is the part that needs code. People undock laptops. A window
 * last seen at x=2400 on the external monitor is, after the walk to the meeting
 * room, off-screen — and a window you cannot see is indistinguishable from an
 * app that failed to start. So a remembered position is a suggestion, checked
 * against the displays that exist now.
 */

export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface WindowState extends Bounds {
    maximised: boolean;
    fullScreen: boolean;
}

/** The shape of an Electron `Display`, narrowed to what the check needs. */
export interface DisplayLike {
    workArea: Bounds;
}

export const DEFAULT_BOUNDS: Bounds = { x: 0, y: 0, width: 1280, height: 860 };
export const MIN_WIDTH = 420;
export const MIN_HEIGHT = 480;

/** How much of a window has to be on a display for it to count as visible. */
const REQUIRED_VISIBLE_PIXELS = 120;

function intersects(bounds: Bounds, area: Bounds): boolean {
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX >= REQUIRED_VISIBLE_PIXELS && overlapY >= REQUIRED_VISIBLE_PIXELS;
}

/**
 * Is this window somewhere a person could actually click it?
 *
 * "On a display" is not enough: a window whose last ten pixels peek onto the
 * screen is technically visible and practically lost.
 */
export function isVisibleOn(bounds: Bounds, displays: readonly DisplayLike[]): boolean {
    return displays.some((display) => intersects(bounds, display.workArea));
}

/** Centre a window on a display's work area. */
export function centreOn(display: DisplayLike, width: number, height: number): Bounds {
    const area = display.workArea;
    return {
        width: Math.min(width, area.width),
        height: Math.min(height, area.height),
        x: Math.round(area.x + (area.width - Math.min(width, area.width)) / 2),
        y: Math.round(area.y + (area.height - Math.min(height, area.height)) / 2),
    };
}

/**
 * Turn a remembered state into bounds for this session's displays.
 *
 * Returns the remembered position when it still works, and a centred window on
 * the primary display when it does not.
 */
export function restoreBounds(
    remembered: Partial<WindowState> | null | undefined,
    displays: readonly DisplayLike[],
    primary: DisplayLike | undefined = displays[0],
): Bounds {
    const fallbackDisplay = primary ?? displays[0];
    const width = clampNumber(remembered?.width, MIN_WIDTH, DEFAULT_BOUNDS.width);
    const height = clampNumber(remembered?.height, MIN_HEIGHT, DEFAULT_BOUNDS.height);

    if (!fallbackDisplay) {
        // No display information at all — hand back something sane rather than
        // refusing to open a window.
        return { ...DEFAULT_BOUNDS, width, height };
    }

    if (typeof remembered?.x !== 'number' || typeof remembered?.y !== 'number') {
        return centreOn(fallbackDisplay, width, height);
    }

    const candidate: Bounds = { x: Math.round(remembered.x), y: Math.round(remembered.y), width, height };
    return isVisibleOn(candidate, displays) ? candidate : centreOn(fallbackDisplay, width, height);
}

function clampNumber(value: unknown, min: number, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.round(value));
}

/**
 * Read a saved state without trusting any of it.
 *
 * The file is JSON on disk; a half-written one, or one edited by hand, must not
 * be able to produce a window with a NaN height.
 */
export function normaliseWindowState(raw: unknown): Partial<WindowState> {
    if (!raw || typeof raw !== 'object') return {};
    const input = raw as Record<string, unknown>;
    const state: Partial<WindowState> = {};
    for (const key of ['x', 'y', 'width', 'height'] as const) {
        const value = input[key];
        if (typeof value === 'number' && Number.isFinite(value)) state[key] = Math.round(value);
    }
    if (typeof input.maximised === 'boolean') state.maximised = input.maximised;
    if (typeof input.fullScreen === 'boolean') state.fullScreen = input.fullScreen;
    return state;
}

/**
 * Alt+M cycles the work mode from the composer.
 *
 * It used to be Shift+Tab, which every browser and screen reader uses to move
 * focus backwards: a keyboard user could not leave the composer, and one stray
 * press switched "Plan first" to "Build directly". Alt+M is not a navigation
 * key. It is matched on the physical key (`code`), because with Alt held macOS
 * types "µ" and `key` is not "m".
 */
export const WORK_MODE_SHORTCUT_LABEL = 'Alt M';

interface ShortcutEvent {
    code?: string;
    key?: string;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}

export function isWorkModeShortcut(e: ShortcutEvent): boolean {
    return e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
        && (e.code === 'KeyM' || (e.code === undefined && (e.key || '').toLowerCase() === 'm'));
}

/** The mode after `current` in the order of `modes`; an unknown current starts at the first. */
export function nextWorkMode(modes: readonly { id: string }[], current: string): string {
    const i = modes.findIndex(m => m.id === current);
    return modes[(i + 1) % modes.length].id;
}

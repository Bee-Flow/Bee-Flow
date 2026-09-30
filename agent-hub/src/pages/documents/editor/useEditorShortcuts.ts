// Keyboard shortcuts of the document editors, from the page around the frame
// (the frame reports its own keys through the bridge; both end up here).

import { useEffect, useRef } from 'react';
import type { FrameKey } from '../canvasBridge';

export type ShortcutHandler = (key: FrameKey) => void;

type KeyInfo = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>;

/** [key, needs Shift, needs Alt (undefined: either)] per shortcut, with Ctrl or ⌘ always. */
const TABLE: Array<[FrameKey, string[], boolean | undefined, boolean | undefined]> = [
    ['history', ['h'], true, undefined],
    ['comment', ['m', 'µ'], undefined, true],
    ['save', ['s'], false, false],
    ['find', ['f'], false, false],
    ['help', ['/'], undefined, undefined],
];

/** The shortcut a key event means, or null. Shared by the page and the frame's report. */
export function shortcutOf(e: KeyInfo): FrameKey | null {
    if (!(e.metaKey || e.ctrlKey)) return null;
    const k = String(e.key || '').toLowerCase();
    const hit = TABLE.find(([, keys, shift, alt]) => keys.includes(k)
        && (shift === undefined || shift === !!e.shiftKey) && (alt === undefined || alt === !!e.altKey));
    return hit ? hit[0] : null;
}

export default function useEditorShortcuts(handler: ShortcutHandler, enabled = true) {
    const latest = useRef(handler);
    useEffect(() => { latest.current = handler; });
    useEffect(() => {
        if (!enabled) return undefined;
        const onKeyDown = (e: KeyboardEvent) => {
            const key = shortcutOf(e);
            if (!key) return;
            e.preventDefault();
            latest.current(key);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [enabled]);
}

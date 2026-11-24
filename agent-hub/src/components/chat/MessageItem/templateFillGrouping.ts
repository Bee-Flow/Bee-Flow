/**
 * Where each field of a fill-in form is shown, and when that may change.
 *
 * The groups, in the order a person works through them: "Asked of you" (a
 * colleague waits for it), "To look at" (the final check has a remark),
 * "Still needed", "Filled in" and "Optional". A field follows its value from
 * group to group when someone else fills it in, stays where it is while this
 * person works in the fields, and goes back to where its value puts it once
 * they have left the fields (TemplateFillFields.tsx renders the result).
 */
import { useEffect, useRef, useState, type FocusEvent } from 'react';

import type { TemplateFillField } from './templateFillTypes';

export const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === ''
    || (Array.isArray(v) && v.length === 0);

export type GroupId = 'asked' | 'remarked' | 'missing' | 'filled' | 'optional';
const GROUP_ORDER: GroupId[] = ['asked', 'remarked', 'missing', 'filled', 'optional'];
/** The groups that ask something of the person: they are never folded away, and fold the others away. */
export const TO_DO = new Set<GroupId>(['asked', 'remarked', 'missing']);

interface Marks { asked?: ReadonlySet<string>; remarked?: ReadonlySet<string> }

function groupOf(field: TemplateFillField, values: Record<string, unknown>, marks: Marks): GroupId {
    if (marks.remarked?.has(field.key)) return 'remarked';
    if (!isEmpty(values[field.key])) return 'filled';
    if (marks.asked?.has(field.key)) return 'asked';
    // Left empty, a field the template has a default for is filled with it: nothing is still needed there.
    return field.required && field.suggestion === undefined ? 'missing' : 'optional';
}

/**
 * Where each field is shown: where its value puts it, or, while the person
 * works in the fields, where it was when they first touched it (focus or a
 * change). `release` lets every field go back to where its value puts it: the
 * person left the fields, so nothing can jump under their cursor any more.
 */
export function useGrouping(fields: TemplateFillField[], values: Record<string, unknown>, marks: Marks) {
    const [pinned, setPinned] = useState<ReadonlyMap<string, GroupId>>(() => new Map());
    const release = () => setPinned((prev) => (prev.size === 0 ? prev : new Map()));
    const live = (f: TemplateFillField) => groupOf(f, values, marks);
    const touch = (key: string) => {
        const field = fields.find((f) => f.key === key);
        if (!field || pinned.has(key)) return;
        const at = live(field);
        setPinned((prev) => (prev.has(key) ? prev : new Map(prev).set(key, at)));
    };
    const groups = GROUP_ORDER
        .map((id) => ({ id, fields: fields.filter((f) => (pinned.get(f.key) ?? live(f)) === id) }))
        .filter((g) => g.fields.length > 0);
    return { groups, touch, release };
}

/** After the pointer is let go, the click it made is given this long to land before anything moves. */
const CLICK_SETTLE_MS = 80;

/**
 * Lets the fields go back to where their values put them once the person has
 * LEFT the fields. Leaving with a click (on "Check and finish" below, say)
 * must not move that button away between pressing and letting go, or the
 * click lands on nothing: so while a pointer is down the regrouping waits
 * until it is up and its click has landed. Leaving with the keyboard regroups
 * at once.
 */
export function useReleaseOnLeave(release: () => void) {
    const pending = useRef(false);
    const pressed = useRef(false);
    const releaseRef = useRef(release);
    useEffect(() => { releaseRef.current = release; });
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const flush = () => {
            if (!pending.current || pressed.current) return;
            pending.current = false;
            releaseRef.current();
        };
        const down = () => { pressed.current = true; };
        const up = () => {
            pressed.current = false;
            if (timer) clearTimeout(timer);
            timer = setTimeout(flush, CLICK_SETTLE_MS);
        };
        window.addEventListener('pointerdown', down, true);
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        return () => {
            if (timer) clearTimeout(timer);
            window.removeEventListener('pointerdown', down, true);
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', up, true);
        };
    }, []);
    const onBlur = (e: FocusEvent<HTMLDivElement>) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        pending.current = true;
        if (!pressed.current) { pending.current = false; release(); }
    };
    // Back in the fields before the regrouping happened: they stay as they are.
    const onFocus = () => { pending.current = false; };
    return { onBlur, onFocus };
}

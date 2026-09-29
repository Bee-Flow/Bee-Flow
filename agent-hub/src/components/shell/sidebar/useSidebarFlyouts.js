import { useState, useRef, useEffect, useCallback } from 'react';

    /* ─── Aim detection ───
       Both panels open BESIDE the row that owns them and can be much taller
       than it. Heading diagonally from the row to an item low in the panel,
       the pointer crosses the rows below the anchor and the 8px gap — and
       each of those rows has its own hover handler. Without this, cutting the
       corner from "Studio" to "Apps" in the panel swapped the panel for the
       Apps one, or closed it, the moment the pointer left the row.

       So a hover that would swap or close a panel first asks where the
       pointer is going: while it is on course for the panel (its recent
       movement, projected onto the panel's left edge, lands within the
       panel's height plus a little slop) the swap/close waits and re-checks;
       once it is inside the panel the swap is dropped, and once it veers
       away the swap happens if the pointer is still over the row that asked
       for it. The gap plus a diagonal never takes more than a few hundred ms,
       so the wait is capped: a pointer that lingers at the sidebar edge does
       not hold a panel open forever. */
const AIM_WINDOW_MS = 150;   // how much movement history informs the direction
const AIM_TICK_MS = 100;     // how often a deferred swap/close re-checks
const AIM_MAX_MS = 1500;     // longest a swap/close can be held off
const AIM_SLOP_PX = 24;      // tolerance above/below the panel's edge

const inside = (p, r) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;

// True when the movement prev→cur, extended to the panel's left edge, meets
// the panel (or the pointer is already over it).
export function headingInto(prev, cur, rect) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return false;
    if (inside(cur, rect)) return true;
    if (cur.x >= rect.left) return false;          // beside or past it, not approaching
    const dx = cur.x - prev.x;
    if (dx <= 0) return false;                     // moving away, or straight up/down
    const yAtEdge = prev.y + (cur.y - prev.y) * (rect.left - prev.x) / dx;
    return yAtEdge >= rect.top - AIM_SLOP_PX && yAtEdge <= rect.bottom + AIM_SLOP_PX;
}

// The panels live in NavRow/FlyoutRow; find them by their test ids so the
// hook needs no refs threaded through.
const panelRect = (prefix, key) => (key && typeof document !== 'undefined'
    ? document.querySelector(`[data-testid="${prefix}-${key}"]`)?.getBoundingClientRect()
    : null);
const pointerState = (trail) => {
    const t = trail.current;
    if (t.length === 0) return null;
    return { prev: t[0], cur: t[t.length - 1] };
};
const pointerOver = (trail, el) => {
    const p = pointerState(trail);
    if (!p) return true;                                         // no data → trust the event
    const r = el?.getBoundingClientRect?.();
    return !r || !(r.width > 0) || inside(p.cur, r);
};

export function useSidebarFlyouts(scrollRef) {
    const [flyout, setFlyout] = useState(null); // { key, top, left } | null
    const [subFlyout, setSubFlyout] = useState(null); // { key, top, left } | null
    // Mirrors of both, for the hover/close paths that decide from inside a timer.
    const flyoutRef = useRef(null);
    flyoutRef.current = flyout;
    const subFlyoutRef = useRef(null);
    subFlyoutRef.current = subFlyout;
    const flyoutCloseTimer = useRef(null);
    const subFlyoutCloseTimer = useRef(null);

    /* Pointer history while a panel is open (mousemove is not tracked
       otherwise). Oldest sample within AIM_WINDOW_MS is the "from" point. */
    const trail = useRef([]);
    useEffect(() => {
        if (!flyout || typeof document === 'undefined') return undefined;
        const onMove = (e) => {
            const now = Date.now();
            const t = trail.current.filter(s => now - s.t <= AIM_WINDOW_MS);
            t.push({ x: e.clientX, y: e.clientY, t: now });
            trail.current = t;
        };
        document.addEventListener('mousemove', onMove, { passive: true });
        return () => { document.removeEventListener('mousemove', onMove); trail.current = []; };
    }, [flyout]);

    /* One deferral loop for both levels: `targets` are the panels the pointer
       may be heading for, `stillWanted` says whether the action is still
       relevant when the pointer has veered off (a swap needs the pointer on
       its row; a close is always wanted). */
    const deferTimers = useRef({});
    const clearDefer = useCallback((slot) => {
        if (deferTimers.current[slot]) { clearTimeout(deferTimers.current[slot]); deferTimers.current[slot] = null; }
    }, []);
    const runWhenNotAiming = useCallback((slot, targets, stillWanted, action) => {
        clearDefer(slot);
        const startedAt = Date.now();
        const tick = () => {
            deferTimers.current[slot] = null;
            const rects = targets().filter(Boolean);
            const p = pointerState(trail);
            if (p && rects.some(r => inside(p.cur, r))) return;     // arrived: nothing to do
            const aiming = !!p && rects.some(r => headingInto(p.prev, p.cur, r));
            if (aiming && Date.now() - startedAt < AIM_MAX_MS) {
                deferTimers.current[slot] = setTimeout(tick, AIM_TICK_MS);
                return;
            }
            if (stillWanted()) action();
        };
        tick();
    }, [clearDefer]);
    const openFlyout = useCallback((key, anchorEl) => {
        if (flyoutCloseTimer.current) { clearTimeout(flyoutCloseTimer.current); flyoutCloseTimer.current = null; }
        clearDefer('flyout');
        const rect = anchorEl.getBoundingClientRect();
        // -6 compensates the panel's own padding so the FIRST item sits level
        // with the row that opened it.
        setFlyout({ key, top: rect.top - 6, left: rect.right + 8 });
    }, [clearDefer]);
    const scheduleFlyoutClose = useCallback((key) => {
        if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current);
        flyoutCloseTimer.current = setTimeout(() => {
            flyoutCloseTimer.current = null;
            runWhenNotAiming(
                'flyout',
                () => [panelRect('flyout', key), panelRect('subflyout', subFlyoutRef.current?.key)],
                () => true,
                () => setFlyout(f => (f?.key === key ? null : f)),
            );
        }, 180);
    }, [runWhenNotAiming]);
    /* ─── Second level: what you were last working on ───
       Hovering a Studio SECTION inside the panel above opens a further panel to
       its right, listing that section's most recent items. Its own state and
       its own grace timer, because the two levels close independently: leaving
       a section row must drop only its sub-panel, not the panel it sits in.

       The sub-panel is rendered INSIDE the section row's wrapper (see
       renderFlyoutRow). It is fixed-positioned and so visually detached, but
       mouseleave follows DOM containment, not geometry — which is exactly what
       lets the pointer travel from the row into the panel without closing it.
       The level-1 panel relies on the same trick. */
    const openSubFlyout = useCallback((key, anchorEl) => {
        if (subFlyoutCloseTimer.current) { clearTimeout(subFlyoutCloseTimer.current); subFlyoutCloseTimer.current = null; }
        clearDefer('subflyout');
        const rect = anchorEl.getBoundingClientRect();
        // Level 1 is w-72 (288px) and sits 8px off the sidebar; level 2 clears
        // it by the same gap. Anchored to the ROW, so the sub-panel lines up
        // with the section it belongs to rather than the top of the panel.
        setSubFlyout({ key, top: rect.top - 6, left: rect.right + 8 });
    }, [clearDefer]);
    const scheduleSubFlyoutClose = useCallback((key) => {
        if (subFlyoutCloseTimer.current) clearTimeout(subFlyoutCloseTimer.current);
        subFlyoutCloseTimer.current = setTimeout(() => {
            subFlyoutCloseTimer.current = null;
            runWhenNotAiming(
                'subflyout',
                () => [panelRect('subflyout', key)],
                () => true,
                () => setSubFlyout(f => (f?.key === key ? null : f)),
            );
        }, 180);
    }, [runWhenNotAiming]);
    /* Hover variants of the two opens: a plain hover opens at once, but a
       hover that would REPLACE an open panel waits while the pointer is on
       course for that panel (see "Aim detection" above). Clicks keep using
       openFlyout/openSubFlyout — a click is never an accident of the path. */
    const hoverFlyout = useCallback((key, anchorEl) => {
        if (flyoutCloseTimer.current) { clearTimeout(flyoutCloseTimer.current); flyoutCloseTimer.current = null; }
        const open = flyoutRef.current;
        if (!open || open.key === key) { openFlyout(key, anchorEl); return; }
        runWhenNotAiming(
            'flyout',
            () => [panelRect('flyout', open.key), panelRect('subflyout', subFlyoutRef.current?.key)],
            () => pointerOver(trail, anchorEl),
            () => openFlyout(key, anchorEl),
        );
    }, [openFlyout, runWhenNotAiming]);
    const hoverSubFlyout = useCallback((key, anchorEl) => {
        if (subFlyoutCloseTimer.current) { clearTimeout(subFlyoutCloseTimer.current); subFlyoutCloseTimer.current = null; }
        const open = subFlyoutRef.current;
        if (!open || open.key === key) { openSubFlyout(key, anchorEl); return; }
        runWhenNotAiming(
            'subflyout',
            () => [panelRect('subflyout', open.key)],
            () => pointerOver(trail, anchorEl),
            () => openSubFlyout(key, anchorEl),
        );
    }, [openSubFlyout, runWhenNotAiming]);
    const closeSubFlyout = useCallback(() => {
        if (subFlyoutCloseTimer.current) { clearTimeout(subFlyoutCloseTimer.current); subFlyoutCloseTimer.current = null; }
        clearDefer('subflyout');
        setSubFlyout(null);
    }, [clearDefer]);
    const closeFlyout = useCallback(() => {
        if (flyoutCloseTimer.current) { clearTimeout(flyoutCloseTimer.current); flyoutCloseTimer.current = null; }
        clearDefer('flyout');
        setFlyout(null);
        // Never leave the second level orphaned on screen once its parent is
        // gone — it is fixed-positioned and would simply hang there.
        closeSubFlyout();
    }, [closeSubFlyout, clearDefer]);
    useEffect(() => () => {
        if (flyoutCloseTimer.current) clearTimeout(flyoutCloseTimer.current);
        if (subFlyoutCloseTimer.current) clearTimeout(subFlyoutCloseTimer.current);
        Object.values(deferTimers.current).forEach(t => t && clearTimeout(t));
    }, []);
    // Escape and sidebar scrolling both dismiss the panel — it is fixed-
    // positioned, so it would visually detach from its row otherwise. closeFlyout
    // takes the sub-panel with it.
    useEffect(() => {
        if (!flyout) return undefined;
        const onKey = (e) => { if (e.key === 'Escape') closeFlyout(); };
        const scroller = scrollRef.current;
        document.addEventListener('keydown', onKey);
        scroller?.addEventListener('scroll', closeFlyout);
        return () => {
            document.removeEventListener('keydown', onKey);
            scroller?.removeEventListener('scroll', closeFlyout);
        };
    }, [flyout, closeFlyout]);
    // A closing level-1 panel can outlive its child by a frame (the two grace
    // timers are independent), so tie the sub-panel's life to its parent's.
    useEffect(() => { if (!flyout) closeSubFlyout(); }, [flyout, closeSubFlyout]);

    return {
        flyout, openFlyout, hoverFlyout, scheduleFlyoutClose,
        subFlyout, openSubFlyout, hoverSubFlyout, scheduleSubFlyoutClose,
        closeSubFlyout, closeFlyout,
    };
}

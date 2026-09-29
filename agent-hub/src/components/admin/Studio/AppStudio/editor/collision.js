import { closestCorners, pointerWithin, rectIntersection } from '@dnd-kit/core';

/**
 * App Studio editor — which droppable a drag is aiming at.
 *
 * WHY NOT closestCorners ALONE (what this replaces).
 *
 * dnd-kit does not collide the CURSOR against droppables; it collides the
 * dragged item's rect. And that rect is the dragged component's ORIGINAL,
 * full-size cell box, merely translated by the pointer delta — a span-12 card
 * stays 900px wide while it is in flight. closestCorners then averages the
 * distances from all four of its corners, with no containment test and no
 * maximum distance. So grabbing a wide component near its right edge puts the
 * effective aim point hundreds of pixels to the LEFT of the cursor, and the
 * drop lands on a component the user was never pointing at.
 *
 * The same unbounded search is why an upward overshoot could resolve onto a
 * `screentab:` droppable in the header and move the component to a different
 * screen entirely (see dnd.computeDragEnd's screen-tab branch) — a surprising,
 * hard-to-undo outcome from a gesture that just went a bit too far.
 *
 * WHAT THIS DOES INSTEAD.
 *
 * The droppable under the POINTER wins. That is the thing the person is
 * actually aiming with, and it is the same call AppKanban.laneCollision already
 * makes for its lanes. `pointerWithin` orders its hits by how close the
 * pointer is to each rect's centre, so for nested droppables (section →
 * container → leaf) the innermost — the smallest box the pointer is inside —
 * comes first, which is the one the user means. Hovering a container's own
 * padding, where no child contains the pointer, still targets the container.
 *
 * Keyboard drags have NO pointer coordinates (dnd-kit's KeyboardSensor moves a
 * synthetic rect, and pointerWithin returns nothing for them), so they fall
 * back to rect intersection and then to closestCorners — which is the correct
 * behaviour there, since the "cursor" is the item itself.
 *
 * Zero-area droppables are dropped from the fallback: nodes inside an inactive
 * `tabs` panel stay MOUNTED and registered (AppTabs hides them with
 * `display:none` rather than unmounting), so they sit in the droppable map with
 * 0×0 rects at the origin. closestCorners has no filter for that, which puts an
 * invisible target near (0,0) permanently in the running for any drag near the
 * top-left. pointerWithin already ignores them — nothing contains a pointer in
 * a zero-area box — so only the fallbacks need the guard.
 */

/** A droppable that occupies no space cannot be aimed at. */
function measurable(entry) {
    const rect = entry?.rect?.current || entry?.rect;
    return !!rect && rect.width > 0 && rect.height > 0;
}

export function canvasCollision(args) {
    const hits = pointerWithin(args);
    if (hits.length) return hits;

    // A POINTER drag that is over nothing droppable is aiming at nothing, and
    // should resolve to nothing. Falling through to the rect strategies here
    // reinstated exactly the unbounded search this function exists to remove:
    // the dragged item's full-size rect, offset by the pointer delta, still
    // reaches droppables hundreds of pixels away — so an overshoot above the
    // canvas could land on a screen tab and move the component to another
    // screen. The fallback is for KEYBOARD drags, which have no pointer at all.
    if (args.pointerCoordinates) return [];

    const droppableContainers = (args.droppableContainers || []).filter(measurable);
    if (!droppableContainers.length) return [];
    const scoped = { ...args, droppableContainers };

    const overlaps = rectIntersection(scoped);
    return overlaps.length ? overlaps : closestCorners(scoped);
}

export default canvasCollision;

/**
 * Everything on the canvas you tap that is not a node, drawn over the nodes
 * (the web lifts its line clusters above the cards for the same reason: a
 * label behind a card is a label you cannot find):
 *
 *   - a line's chip (its branch, when its port does not already say it) and
 *     its "+", which inserts a step ON that line — or, in connect mode, its
 *     "×", which removes a real connection (a loop body's lines are its
 *     order, so they have none);
 *   - a "+" beside every port nothing leaves from, and at the end of an open
 *     loop's body;
 *   - a loop's "N steps inside" (open it here) and an open loop's close;
 *   - in connect mode, a target on every port a line can leave from.
 *
 * None of these sit inside a node's gesture: a node's tap would race a
 * button's press. Below 60% only the connect targets stay: the rest would
 * be too small to hit.
 *
 * This module holds what the overlay's controls share; each control is its
 * own file (EdgeControls, AddSpotButton, LoopToggle, PortTarget).
 */

export type CanvasMode = 'edit' | 'connect';

/** How far past its edge a small control still takes a tap. */
export const HIT = { top: 10, bottom: 10, left: 10, right: 10 };

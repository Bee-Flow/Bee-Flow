/** The inverted transcript's scrolling: an in-answer anchor, and when "Jump to latest" shows. */

import { awayFromLatest, invertedOffsetFor } from './useListScrollHost';

it('moves the list by how far the heading is below the top edge, never past the start', () => {
    // Heading 400px below a list whose top is at 100: 12px headroom leaves 288 to go.
    expect(invertedOffsetFor(1000, 100, 400)).toBe(1000 - 288);
    // Above the edge: scroll the other way.
    expect(invertedOffsetFor(1000, 100, 50)).toBe(1062);
    expect(invertedOffsetFor(10, 100, 900)).toBe(0);
});

it('shows the jump once the newest message is well out of view, and hides it only near it again', () => {
    expect(awayFromLatest(false, 0)).toBe(false);
    expect(awayFromLatest(false, 300)).toBe(false);
    expect(awayFromLatest(false, 600)).toBe(true);
    // Between the two thresholds it keeps what it was: no flicker at the edge.
    expect(awayFromLatest(true, 300)).toBe(true);
    expect(awayFromLatest(true, 100)).toBe(false);
});

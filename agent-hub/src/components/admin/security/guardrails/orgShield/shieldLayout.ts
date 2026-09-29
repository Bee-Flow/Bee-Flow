/**
 * How wide the Privacy Shield may get, in one place.
 *
 * The settings page mounts the editor FULL BLEED on purpose (a 21-row matrix,
 * a world map and two wide tables need the room), but past a full-HD content
 * width more room stops helping: on a 2560 or 3440 screen the matrix's
 * checkboxes ended up 1500px from the kind they belong to. So the chrome
 * (header, strip, save bar) keeps its full-width background while every row of
 * CONTENT is capped and centred at the same width, so their edges line up.
 *
 * `PANE` also names the container every pane lays itself out against. The
 * editor sits beside the settings nav in one mount and inside the admin
 * console in another, so the viewport width (what sm:/lg:/xl: read) says
 * little about the room a pane actually has; `@min-[…px]/pane:` does.
 *
 * Tailwind only generates classes it can read in the source, so both strings
 * are complete literals.
 */

/** A padded (px-6) chrome row: 1760px of content plus its 2 × 24px padding. */
export const SHIELD_ROW = 'mx-auto w-full max-w-[1808px]';

/** The pane's content box inside the scroll area, and the container it queries. */
export const SHIELD_PANE = '@container/pane mx-auto w-full max-w-[1760px]';

/*
 * On a short screen (a 1366×768 or 1280×720 laptop, less the browser's own
 * bars) the header, the strip and the save bar stay pinned while the pane
 * scrolls, so each gives back a few pixels of padding below 780px of height:
 * `[@media(max-height:780px)]:` on those three rows and on the pane.
 */

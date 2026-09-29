/**
 * The suggestion list's layout on a wide "Find repeating work" tab: one
 * column of rows in a laptop-sized column, two side by side once the tab is
 * 56rem wide (its `@container/repeating`, never the viewport). The hairlines
 * come from a 1px gap over the border colour, so every row must paint its own
 * card background, and a lone last row spans both columns rather than leaving
 * a grey hole. Shared by the list and its loading skeleton so the two never
 * jump between layouts.
 */
export const SUGGESTION_GRID = '@[56rem]/repeating:grid @[56rem]/repeating:grid-cols-2 @[56rem]/repeating:gap-px '
    + '@[56rem]/repeating:divide-y-0 @[56rem]/repeating:bg-[var(--border-default)] '
    + '@[56rem]/repeating:[&>*:last-child:nth-child(odd)]:col-span-2';

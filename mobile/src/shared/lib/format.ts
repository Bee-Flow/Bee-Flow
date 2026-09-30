/**
 * Small text formatters that belong to no one feature.
 *
 * Its two neighbours came first and stayed in their own files because each
 * carries a page of reasoning: `time.ts` for `relativeTime`, `bytes.ts` for
 * `formatBytes`. This is where the rest land — the helpers too small to earn a
 * module and too shared to sit in one feature's `format.ts`.
 *
 * There is deliberately no `formatDuration` here, which is the surprise. Two
 * exist — `features/recording/model/format.ts` and `features/automations/model/format.ts` —
 * and they are not the same function wearing two hats. One takes seconds and
 * renders a clock ("8:04", "1:05:30") because it also labels seek positions in
 * a transcript; the other takes milliseconds and renders a spoken elapsed
 * ("0.4s", "3m 04s") because a run that took 400ms is not "0:00". Merging them
 * would mean picking a unit and a shape, and either pick breaks one of the two
 * screens. Both files say so at their own definition.
 */

/**
 * "3 steps" / "1 step".
 *
 * Existed twice, in `features/automations/model/format.ts` and
 * `features/library/model/format.ts`, with identical behaviour and different
 * parameter names — the only pair of duplicates in this app that agreed on
 * everything, which is exactly why neither author noticed the other.
 *
 * `many` is a parameter rather than an "s" because English does not always
 * add one, and the caller with "entries"/"entry" should not have to write the
 * whole phrase out to say so.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

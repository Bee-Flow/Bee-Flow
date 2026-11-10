/**
 * The demo's one clock.
 *
 * The demos used to run on the real clock while their fixtures carry real
 * dates (the compliance catalogue's `in_force_since`, the AI Act milestones).
 * So the demo aged: from 2026-11-10 no framework was inside the 60-day
 * "recently in force" window any more, and that part of the page — the reason
 * it exists — was empty. A demo is a prepared scene, and a scene has a date.
 *
 * `DEMO_NOW_ISO` is that date. Every fixture reads the time through `demoNow()`
 * / `demoDate()`, and DemoHost shifts the page's own `Date` to the same clock
 * (`installDemoClock`, through useDemoClock), because the real components work out "3 days ago" and
 * "due in 5 days" themselves: a fixture dated in the demo and a page reading
 * the real clock would disagree by however long ago the demo date is.
 *
 * The clock is anchored, not frozen: it starts at the demo date when this
 * module loads and then runs, so "just now" stays just now and nothing that
 * measures a duration sees time stand still.
 */

/**
 * The moment the demo is set at.
 *
 * It must stay ON OR AFTER the newest `in_force_since` in
 * fixtures/complianceCatalog.js that has already passed (2026-09-11) and no
 * more than 60 days after it, or "recently in force" has nothing to show;
 * 2026-10-05 also keeps the 2026-08-15 batch inside the window and the
 * 2026-08-02 one just outside it, so both sides of the rule are on screen.
 * compliance.test.js checks this against the catalogue: move the date only
 * together with the catalogue.
 */
export const DEMO_NOW_ISO = '2026-10-05T09:30:00.000Z';

/** The real `Date`, kept from before the page's own is shifted. */
const RealDate = Date;
const DEMO_EPOCH_MS = RealDate.parse(DEMO_NOW_ISO);
const loadedAt = RealDate.now();

/** The demo's "now" in epoch milliseconds. */
export function demoNow(): number {
    return DEMO_EPOCH_MS + (RealDate.now() - loadedAt);
}

/** The demo's "now" as a Date. */
export function demoDate(): Date {
    return new RealDate(demoNow());
}

/** The page's own `Date` from before the shift, and the shifted one, while the shift is in place. */
let shift: { before: DateConstructor; shifted: DateConstructor } | null = null;
/** How many hosts asked for the shift: it is taken back when the last one lets go. */
let holders = 0;

/**
 * Put the page on the demo's clock. Only the three ways of asking for "now"
 * change: `Date.now()`, `new Date()` and `Date()`. Everything else is the real
 * `Date` itself, reached through a Proxy: `new Date(value)`, `new Date(y, m, d)`,
 * `Date.parse`, `Date.UTC`, `Date.prototype`, and `instanceof Date` for dates
 * made before, during and after. `performance.now()` is not touched.
 *
 * Counted: each install is paired with one uninstall.
 */
export function installDemoClock(): void {
    const scope = globalThis as { Date: DateConstructor };
    holders += 1;
    if (shift && scope.Date === shift.shifted) return;
    const before = scope.Date;
    const shifted = new Proxy(before, {
        // (`newTarget` goes along, so a class that extends Date still builds its own kind.)
        construct: (target, args: unknown[], newTarget) => Reflect.construct(target, args.length === 0 ? [demoNow()] : args, newTarget) as Date,
        apply: () => new RealDate(demoNow()).toString(),
        get: (target, key) => (key === 'now' ? demoNow : Reflect.get(target, key) as unknown),
    });
    scope.Date = shifted;
    shift = { before, shifted };
}

/**
 * Let go of the demo's clock; the page's own comes back with the last holder.
 * Only our own shift is taken back: while a test's fake clock sits over it,
 * it stays, and a later call takes it back.
 */
export function uninstallDemoClock(): void {
    const scope = globalThis as { Date: DateConstructor };
    holders = Math.max(0, holders - 1);
    if (holders > 0 || !shift || scope.Date !== shift.shifted) return;
    scope.Date = shift.before;
    shift = null;
}

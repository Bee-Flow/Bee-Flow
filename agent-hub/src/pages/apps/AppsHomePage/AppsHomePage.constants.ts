import { kindTileStyle } from '../../../components/shared/kindColors';
import type { TFn } from '../AppsHomePage.types';

// Matches AppList / APP_COLOR_PRESETS[0] (teal).
export const DEFAULT_ACCENT = '#0F766E';

// The header mark: the APP kind's 26px tile at a 14% tint, straight from
// shared/kindColors — this page never spells the colour itself, so a theme
// change recolours it with every other app tile in the product.
export const APP_TILE = kindTileStyle('app', { size: 26, pct: 14 });

// ── "Recently used" (per device, per user) ──────────────────────────
// Which apps THIS person reaches for. The directory can hold twenty tools and
// a person uses three of them, so the honest shortcut is "the ones you opened",
// not "the ones most recently saved by whoever built them".
//
// That signal does not exist on the server, and giving it one is a decision
// nobody has taken yet: a `studio_app_opens` table would record, per named
// person, which internal tools they open and when — an attendance log by
// accident. In a privacy product that question gets asked out loud before it
// gets built, so this half of the feature stays on the device, in per-user
// scoped storage, exactly as `utils/formRecents.ts` argues for forms.
//
// The one thing this deliberately does NOT copy from formRecents: that helper
// falls back to publication date so the sidebar always has five forms to show.
// A block with the words "Recently used" over it may not do that — an app you
// have never opened appearing under that heading is simply a false statement.
// No history means no section.
export const RECENTS_KEY = 'appRecents';

// A few more than the section shows, so dropping off the list is not the same
// as being forgotten — reopening an older app should restore its place.
export const REMEMBERED = 12;

// The design's row of three wide cards. More than that and "recent" stops
// being a shortcut and becomes a second copy of the directory.
export const RECENTS_SHOWN = 3;

// ── Category filter (closed vocabulary) ─────────────────────────────
// A CLOSED vocabulary, on purpose. Free-text categories give you twelve
// chips and a spelling mistake ("Finance", "finance", "Financiën"); a fixed
// list keeps the row short and makes the same department read the same word
// in every organisation. The value lives on the app row (server side) — this
// list is the only thing that may become a chip.
//
// Anything else an app carries (an empty value, a legacy free-text string, a
// category retired from the list) is treated as UNCATEGORISED: the app stays
// reachable under "All" and never mints a chip of its own. That is what makes
// the list closed rather than merely suggested.
export const APP_CATEGORIES = ['sales', 'service', 'finance', 'hr', 'internal'];

// Labels resolve through t() at the call site (never stored English), so the
// pill row follows the reader's language while the stored value stays a
// stable key.
export const CATEGORY_LABELS: Record<string, (t: TFn) => string> = {
    sales: (t) => t('apps.category.sales', 'Sales'),
    service: (t) => t('apps.category.service', 'Service'),
    finance: (t) => t('apps.category.finance', 'Finance'),
    hr: (t) => t('apps.category.hr', 'HR'),
    internal: (t) => t('apps.category.internal', 'Internal'),
};

// ── "new" ───────────────────────────────────────────────────────────
// A badge that says an app was published recently. Two weeks, not one: a
// reader back from a week away should still be told what appeared while they
// were gone, and a badge that expires faster than a holiday tells the people
// who most need it the least.
//
// publishedAt is the only date that can carry this. updatedAt moves every
// time the builder saves a typo fix, and a tool everyone has used for a year
// wearing a "new" badge because of a comma is worse than no badge at all.
export const NEW_FOR_MS = 14 * 24 * 60 * 60 * 1000;

export const PILL_CLASSES = 'rounded-full border px-3 py-1 text-xs font-medium transition-colors';

export const CARD_CLASSES = 'group relative rounded-xl border p-3.5 transition-all hover:shadow-md text-left block no-underline';

export const CARD_STYLE = { borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' };

// Four across on a wide screen (the design's grid), and a single column on a
// phone — the reason /app/apps is on the mobile allow-list at all.
export const GRID_CLASSES = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3';

// Exactly two lines of description, reserved whether or not there IS one.
// Without the reserved box a card with a description stands taller than one
// without, every row in the grid ends at a different height, and the footer
// rules below stop lining up across the row.
export const DESC_CLASSES = 'h-[34px] overflow-hidden text-[11.5px] leading-[17px] mt-2';

/**
 * A load failure that carried no message of its own.
 *
 * Kept as a MARKER rather than as ready-made English because `load()` must not
 * depend on `t`: with no TranslationProvider above it (embeds, isolated tests)
 * `useTranslation()` hands back a freshly built `t` on every render, so naming
 * `t` in load()'s dependency list would rebuild `load`, re-fire the effect that
 * calls it, and refetch the directory forever. The banner resolves the marker
 * at render time instead, where a new `t` costs nothing.
 */
export const GENERIC_LOAD_ERROR = Symbol('apps.load_failed');

/**
 * The class recipes every part of Cowork is built from, so it reads as one page and as the same product as the rest of
 * Bee Flow (the Button primitive of ../shared/buttonClasses.ts, the cards and fields of the admin settings).
 *
 * The rules behind them, for whoever adds one:
 *   - flat surfaces: `--bg-card` on `--bg-primary`, a solid 1px border, no shadow, no tinted see-through fill;
 *   - text in whole pixels from the app's scale (12, 13, 14, 16, 20, 24), body 14, weights 400/500/600, the inherited
 *     font; `--text-primary` for body, `--text-secondary` / `--text-tertiary` for meta, never under 12px;
 *   - controls 36px high, 44px where the pointer is a finger, in the shape of the Button primitive (`rounded-lg`, which
 *     is `--radius-lg` here); cards `--radius-lg`, a surface inside a card `--radius-md`;
 *   - colour changes take 120ms (TINT of ./coworkMotion.ts), and nothing carries a transform at rest.
 *
 * Literal strings, so Tailwind keeps them.
 */
import { FOCUS_RING, PRIMARY_TONE } from '../shared/buttonClasses';
import { TINT } from './coworkMotion';

/**
 * The height of a control: 36px, and 44px where the pointer is a finger. Important there, because src/app.css sets
 * `button { min-height: 36px }` under 768px outside any layer, which beats a plain utility at phone width.
 */
export const CONTROL_HEIGHT = 'min-h-9 pointer-coarse:min-h-11!';

/** The focus ring of a row inside a card: drawn inside the row, where the card's rounded edge cannot clip it. */
export const FOCUS_INSET = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]';

const BUTTON = `inline-flex items-center justify-center gap-1.5 ${CONTROL_HEIGHT} px-3.5 py-1.5 rounded-lg border text-[13px] leading-5 font-semibold ${TINT} disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`;

/** The one primary action of a card or a form. */
export const BUTTON_PRIMARY = `${BUTTON} ${PRIMARY_TONE}`;

/** The secondary way out next to it. */
export const BUTTON_SECONDARY = `${BUTTON} bg-[var(--bg-card)] text-[var(--text-primary)] border-[var(--border-default)] enabled:hover:bg-[var(--item-hover-bg)]`;

/** The action that cannot be taken back. */
export const BUTTON_DANGER = `${BUTTON} border-transparent bg-[var(--error)] text-[var(--bg-card)] enabled:hover:opacity-90`;

/** A quiet text action in a row of other things ("Admin rules", "Undo"). */
export const LINK_INLINE = `inline-flex items-center gap-1.5 ${CONTROL_HEIGHT} px-2 rounded-lg text-[13px] leading-5 font-medium text-[var(--text-primary)] underline-offset-4 hover:underline disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`;

/** The same at the start of a line ("Start from a template", "Show 3 more", "Tasks"): pulled 8px left, so its text lines up with the text above it. */
export const LINK_BUTTON = `${LINK_INLINE} -ml-2`;

/** A square button that holds one 16px icon (the gear of the home). */
export const ICON_BUTTON = `inline-grid place-items-center ${CONTROL_HEIGHT} min-w-9 pointer-coarse:min-w-11! rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)] ${TINT} ${FOCUS_RING}`;

/** The names these two had while they were pills; the same buttons. */
export const PILL_PRIMARY = BUTTON_PRIMARY;
export const PILL_QUIET = BUTTON_SECONDARY;

/** A flat surface: the composer, the confirmation, the lists. Its padding is the caller's (16px). */
export const CARD = 'rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--bg-card)]';

/** A surface inside a card or beside one: an example, a note. */
export const CARD_INSET = 'rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)]';

/** A row that is one button (a task in a list, the Teamwork row): the whole row is the target, the ring stays inside it. */
export const LIST_ROW = `w-full min-h-11 px-4 py-3 text-left text-[14px] leading-5 hover:bg-[var(--item-hover-bg)] ${TINT} ${FOCUS_INSET}`;

/** The heading of a section ("Needs you · 3", "Your tasks", "Steps"). */
export const SECTION_HEADING = 'm-0 text-[13px] leading-5 font-semibold text-[var(--text-secondary)]';

/** What explains or accompanies: one size under the body. */
export const META = 'text-[13px] leading-5 text-[var(--text-secondary)]';

/** The label of a field. */
export const LABEL = 'text-[13px] leading-5 font-medium text-[var(--text-primary)]';

const FIELD_BASE = `${CONTROL_HEIGHT} rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[14px] leading-5 text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] ${TINT} focus:outline-none focus-visible:border-[var(--text-secondary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-60`;

/** A short field that takes the width of what it holds (a day, a time). */
export const FIELD = `${FIELD_BASE} px-2.5 max-w-full`;

/** A field that fills its row (a name, a sentence, an address). */
export const FIELD_WIDE = `${FIELD_BASE} w-full px-3 py-1.5`;

/** What went wrong, in one plain sentence. */
export const ALERT = 'm-0 text-[13px] leading-5 text-[var(--error-ink)]';

// Small labels that say a state. The fill is the tone mixed INTO the card's colour: a solid colour, not a see-through one.
const TAG = 'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] leading-4 font-medium whitespace-nowrap';
export const TAG_PLAIN = `${TAG} bg-[var(--bg-tertiary)] text-[var(--text-secondary)]`;
export const TAG_OK = `${TAG} bg-[color-mix(in_srgb,var(--success)_12%,var(--bg-card))] text-[var(--success-ink)]`;
export const TAG_WARN = `${TAG} bg-[color-mix(in_srgb,var(--warning)_14%,var(--bg-card))] text-[var(--warning-ink)]`;
export const TAG_BAD = `${TAG} bg-[color-mix(in_srgb,var(--error)_10%,var(--bg-card))] text-[var(--error-ink)]`;
export const TAG_ACCENT = `${TAG} bg-[color-mix(in_srgb,var(--accent-primary)_14%,var(--bg-card))] text-[var(--accent-primary)]`;
/** Work in progress (Running, Testing). */
export const TAG_LIVE = `${TAG} bg-[color-mix(in_srgb,var(--type-ai)_12%,var(--bg-card))] text-[var(--type-ai)]`;

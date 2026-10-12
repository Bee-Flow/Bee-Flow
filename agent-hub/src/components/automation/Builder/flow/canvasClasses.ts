/**
 * canvasClasses: the automation canvas's look as static Tailwind strings, for
 * surfaces that borrow it OUTSIDE React Flow (the "Find repeating work" page,
 * MiniNode, MiniFlow). The canvas itself paints through inline styles from
 * nodeTypeColors.js; a page under the no-`style={{}}` ratchet cannot, so this
 * module spells the same recipe out as classes.
 *
 * Every string below is a LITERAL on purpose: Tailwind's JIT only generates a
 * class it can read in the source, so nothing here is built with a template
 * string at runtime. The colour decisions are still not made here.
 * canvasClasses.test.ts checks every family entry against `typeColorVar` /
 * `typeTint` from nodeTypeColors.js, and the status entries against the shared
 * status table, so this file cannot drift from the canvas without a red test.
 *
 * Composition: CANVAS_CARD carries the neutral border and the base radius.
 * TRIGGER_RADIUS, STATUS_RING and CARD_DASHED override with `!` so they win no
 * matter which order Tailwind emits the utilities in.
 */
/** A canvas family, one of nodeDefs.NODE_FAMILIES (the test holds the two together). */
export type CanvasFamily = 'trigger' | 'ai' | 'app' | 'branch' | 'loop' | 'data' | 'pause' | 'guard' | 'end';

/** The families a mini card can wear. `people` is the canvas's pause family (approvals, forms). */
export type MiniFamily = 'trigger' | 'app' | 'ai' | 'data' | 'branch' | 'people';

export type MiniStatus = 'idle' | 'running' | 'done' | 'skipped' | 'error';

/** Mini family → the canvas family whose `--type-*` token it paints with. */
export const FAMILY_TOKEN: Readonly<Record<MiniFamily, CanvasFamily>> = Object.freeze({
    trigger: 'trigger',
    app: 'app',
    ai: 'ai',
    data: 'data',
    branch: 'branch',
    people: 'pause',
});

/** The card body: StepNodeBase's container (bg-card, gap 10, padding 0 10 0 14, 72px). */
export const CANVAS_CARD = 'relative flex items-center gap-2.5 pl-3.5 pr-2.5 min-h-[72px] min-w-0 bg-[var(--bg-card)] border border-solid border-[var(--border-default)] rounded-[var(--radius-md)]';
/** The tighter card used inside a compact MiniFlow (pattern previews). */
export const CANVAS_CARD_COMPACT = 'relative flex items-center gap-2 pl-3 pr-2 min-h-[48px] min-w-0 bg-[var(--bg-card)] border border-solid border-[var(--border-default)] rounded-[var(--radius-md)]';
/** nodeTypeColors.cardRadius('trigger'): the leading edge is a pill. */
export const TRIGGER_RADIUS = '!rounded-[36px_var(--radius-md)_var(--radius-md)_36px]';
/** A placeholder card: "Connect", "Trigger to choose". No family bar. */
export const CARD_DASHED = '!border-dashed !border-[1.5px] !border-[var(--text-tertiary)] !shadow-none';

/** The kicker above the name ("TRIGGER · 1"), StepNodeBase near LOD. */
export const EYEBROW = 'flex items-center gap-1.5 text-[10px] leading-3 font-semibold uppercase tracking-[.06em] whitespace-nowrap overflow-hidden';
export const NODE_NAME = 'text-[13px] font-semibold leading-[17px] text-[var(--text-primary)] line-clamp-2 break-words';
export const NODE_NAME_COMPACT = 'text-[12px] font-semibold leading-4 text-[var(--text-primary)] truncate';
export const NODE_SUB = 'text-[11px] leading-[14px] truncate text-[var(--text-secondary)]';

/** The 34px icon tile (typeTileStyle) minus colour, which familyClasses().tile adds. */
export const ICON_TILE = 'w-[34px] h-[34px] shrink-0 grid place-items-center rounded-[9px]';
export const ICON_TILE_COMPACT = 'w-[26px] h-[26px] shrink-0 grid place-items-center rounded-[7px]';

/** The "52 records" pill that sits on an edge (edges.jsx). */
export const RECORD_PILL = 'text-[10px] font-semibold px-1.5 py-0.5 rounded-full border bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-default)] shadow-sm tabular-nums whitespace-nowrap';

/** React Flow's <Background gap={16} size={1} color="var(--border-default)" />, as a class. */
export const DOT_GRID = 'bg-[var(--bg-primary)] bg-[radial-gradient(var(--border-default)_1px,transparent_1px)] bg-[length:16px_16px]';

/** An edge: 1.5px in --border-default; the dashed one is the canvas's wrap edge. */
export const CONNECTOR = 'border-solid border-[var(--border-default)]';
export const CONNECTOR_DASHED = 'border-dashed border-[var(--border-default)]';
/** The ArrowClosed marker (DiagramPane DEFAULT_EDGE_OPTIONS): --text-tertiary. */
export const CONNECTOR_ARROW = 'text-[var(--text-tertiary)]';

/** The canvas's top-left chips (DiagramPane). */
export const CANVAS_CHIP = 'inline-flex items-center gap-1.5 px-2.5 py-[5px] rounded-lg bg-[var(--bg-card)] border border-[var(--border-default)] text-[12px] text-[var(--text-secondary)] shadow-sm';
/** The canvas's primary action (CategoryTabs' active tab colours, floating-button geometry). */
export const CANVAS_BUTTON_PRIMARY = 'inline-flex items-center gap-1.5 px-3 py-[7px] rounded-lg border border-transparent shadow-sm text-[12px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition';

export interface FamilyClasses {
    /** The icon tile's fill (18% tint) and glyph colour. */
    tile: string;
    /** The family colour as text (the eyebrow's label). */
    text: string;
    /** The 4px inset family bar plus --shadow-sm (cardChrome). */
    bar: string;
    /** The family colour as a border colour (a source tile, a branch pill). */
    border: string;
}

const FAMILY_CLASSES: Readonly<Record<MiniFamily, FamilyClasses>> = Object.freeze({
    trigger: {
        tile: 'bg-[color-mix(in_srgb,var(--type-trigger)_18%,transparent)] text-[var(--type-trigger)]',
        text: 'text-[var(--type-trigger)]',
        bar: 'shadow-[inset_4px_0_0_var(--type-trigger),var(--shadow-sm)]',
        border: 'border-[var(--type-trigger)]',
    },
    app: {
        tile: 'bg-[color-mix(in_srgb,var(--type-app)_18%,transparent)] text-[var(--type-app)]',
        text: 'text-[var(--type-app)]',
        bar: 'shadow-[inset_4px_0_0_var(--type-app),var(--shadow-sm)]',
        border: 'border-[var(--type-app)]',
    },
    ai: {
        tile: 'bg-[color-mix(in_srgb,var(--type-ai)_18%,transparent)] text-[var(--type-ai)]',
        text: 'text-[var(--type-ai)]',
        bar: 'shadow-[inset_4px_0_0_var(--type-ai),var(--shadow-sm)]',
        border: 'border-[var(--type-ai)]',
    },
    data: {
        tile: 'bg-[color-mix(in_srgb,var(--type-data)_18%,transparent)] text-[var(--type-data)]',
        text: 'text-[var(--type-data)]',
        bar: 'shadow-[inset_4px_0_0_var(--type-data),var(--shadow-sm)]',
        border: 'border-[var(--type-data)]',
    },
    branch: {
        // typeTileStyle: a branch's tile is a 45° diamond; MiniNode counter-rotates the glyph.
        tile: 'bg-[color-mix(in_srgb,var(--type-branch)_18%,transparent)] text-[var(--type-branch)] rotate-45 scale-[.85] !rounded-[7px]',
        text: 'text-[var(--type-branch)]',
        bar: 'shadow-[inset_4px_0_0_var(--type-branch),var(--shadow-sm)]',
        border: 'border-[var(--type-branch)]',
    },
    people: {
        tile: 'bg-[color-mix(in_srgb,var(--type-pause)_18%,transparent)] text-[var(--type-pause)]',
        text: 'text-[var(--type-pause)]',
        bar: 'shadow-[inset_4px_0_0_var(--type-pause),var(--shadow-sm)]',
        border: 'border-[var(--type-pause)]',
    },
});

/** The family's classes; an unknown family falls back to `app`, the neutral action look. */
export function familyClasses(family: MiniFamily | string | null | undefined): FamilyClasses {
    return FAMILY_CLASSES[family as MiniFamily] ?? FAMILY_CLASSES.app;
}

/**
 * The run-status chrome (cardChrome): a 1.5px border and a 4px 22% ring in the
 * status colour. The ring is an outline rather than cardChrome's extra shadow,
 * because the shadow slot already carries the family bar. Running is the
 * canvas's pulse: a 3px outline at offset 3 breathing through bf-node-pulse.
 */
export const STATUS_RING: Readonly<Record<MiniStatus, string>> = Object.freeze({
    idle: '',
    running: '!border-[1.5px] !border-[var(--type-ai)] outline-3 outline-solid outline-offset-[3px] outline-[var(--type-ai)] [--bf-pulse-color:var(--type-ai)] animate-[bf-node-pulse_1.4s_ease-in-out_infinite] motion-reduce:animate-none',
    done: '!border-[1.5px] !border-[var(--success)] outline-4 outline-solid outline-[color-mix(in_srgb,var(--success)_22%,transparent)]',
    skipped: '!border-dashed opacity-70',
    error: '!border-[1.5px] !border-[var(--error)] outline-4 outline-solid outline-[color-mix(in_srgb,var(--error)_22%,transparent)]',
});

/** The solid badge in the card's top-right corner (StepNodeBase's status badge). */
export const STATUS_PILL_BASE = 'absolute -top-[9px] right-2.5 text-[10px] font-bold leading-4 px-1.5 rounded-md whitespace-nowrap text-white';
export const STATUS_PILL: Readonly<Record<MiniStatus, string>> = Object.freeze({
    idle: '',
    running: 'bg-[var(--type-ai)]',
    done: 'bg-[var(--success)]',
    skipped: '',
    error: 'bg-[var(--error)]',
});

/** STATUS_BADGE's words (nodeTypeColors.js), so the mini card says what the canvas says. */
export const STATUS_PILL_LABEL: Readonly<Partial<Record<MiniStatus, { key: string; en: string }>>> = Object.freeze({
    running: { key: 'automations.card.badge_running', en: 'running' },
    done: { key: 'automations.card.badge_done', en: 'done' },
    error: { key: 'automations.card.badge_failed', en: 'failed' },
});

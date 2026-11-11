/**
 * App Studio validator: a warning when a component draws text over a background image that
 * has no veil (style knob group "backdrop").
 *
 * A picture has no single colour, so the text on it cannot be measured. The veil
 * (backgroundOverlay dim or light) is the answer the group offers, so the check is simply
 * that one is set. Types that carry no text of their own are skipped. Only a warning: the
 * definition saves and publishes.
 */

interface Finding { code: string; severity: string; path: string; message: string; hint: string }
type Push = (rec: Finding) => void;
type Obj = Record<string, unknown>;

/** Deeper than any legal definition (componentSpecs LIMITS.MAX_DEPTH); a bound on the walk only. */
const MAX_WALK_DEPTH = 32;
/** Types that carry no text of their own: a picture behind them is decoration. */
const NO_TEXT_TYPES = new Set(['image', 'spacer', 'divider']);

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

function warnNode(node: Obj, path: string, pushW: Push): void {
    const style = node.style;
    if (!isObj(style) || typeof style.backgroundImage !== 'string') return;
    if (typeof node.type !== 'string' || NO_TEXT_TYPES.has(node.type)) return;
    if (style.backgroundOverlay === 'dim' || style.backgroundOverlay === 'light') return;
    pushW({
        code: 'style.image_without_overlay',
        severity: 'warning',
        path: `${path}.style.backgroundImage`,
        message: 'This component shows text over a background image without a veil, so the text may be hard to read.',
        hint: 'Set backgroundOverlay to "dim" (for light text) or "light" (for dark text), or move the text off the picture.',
    });
}

function walk(nodes: unknown, path: string, depth: number, pushW: Push): void {
    if (!Array.isArray(nodes) || depth > MAX_WALK_DEPTH) return;
    nodes.forEach((node, i) => {
        if (!isObj(node)) return;
        const p = `${path}[${i}]`;
        warnNode(node, p, pushW);
        walk(node.children, `${p}.children`, depth + 1, pushW);
    });
}

/** Warn for every node with a background image and no overlay. */
export function checkBackdropContrast(screens: unknown, pushW: Push): void {
    if (!Array.isArray(screens)) return;
    screens.forEach((screen, si) => {
        if (!isObj(screen) || !Array.isArray(screen.sections)) return;
        screen.sections.forEach((section, ci) => {
            if (isObj(section)) walk(section.children, `screens[${si}].sections[${ci}].children`, 0, pushW);
        });
    });
}

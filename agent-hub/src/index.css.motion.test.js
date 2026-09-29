// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Source scan of index.css for the routines-canvas motion rules — the same
 * shape as i18n/i18nGuard.test.js: read the file, parse just enough, pin the
 * invariants that a browser would not report and a reviewer would not spot.
 *
 * 1. No `[data-anim…]` selector touches a `.bf-*` class. data-anim on <html>
 *    is the GLASS THEME's sheen level (default 'off'); gating builder motion
 *    on it switched the animation off for nearly everyone. Motion is gated on
 *    prefers-reduced-motion only.
 * 2. Every animated `.bf-*` / `[data-build…]` selector has a counterpart
 *    inside a `@media (prefers-reduced-motion: reduce)` block that sets
 *    `animation: none` — plus the five selectors the design names outright.
 * 3. No rule whose subject is `.react-flow__node` transitions or animates
 *    transform (or the individual translate/scale/rotate properties). React
 *    Flow positions that wrapper with an inline translate() and draws edges
 *    from store positions; a tween there leaves the lines snapping ahead.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(here, 'index.css'), 'utf8');

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

// ── A minimal CSS block parser ────────────────────────────────────────────
// Enough for this stylesheet: comments stripped, then braces matched into a
// tree of { prelude, declarations, children }. When a block holds both
// declarations and nested blocks, the text before the last `;` belongs to
// the parent and the remainder is the child's prelude.

function stripComments(css) {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function norm(s) {
    return s.replace(/\s+/g, ' ').trim();
}

export function parseBlocks(css) {
    const root = { prelude: '', declarations: '', children: [], parent: null };
    const stack = [root];
    let buf = '';
    for (const ch of stripComments(css)) {
        const top = stack[stack.length - 1];
        if (ch === '{') {
            const cut = buf.lastIndexOf(';');
            const prelude = cut === -1 ? buf : buf.slice(cut + 1);
            if (cut !== -1) top.declarations += buf.slice(0, cut + 1);
            const node = { prelude: norm(prelude), declarations: '', children: [], parent: top };
            top.children.push(node);
            stack.push(node);
            buf = '';
        } else if (ch === '}') {
            top.declarations += buf;
            buf = '';
            stack.pop();
        } else {
            buf += ch;
        }
    }
    return root;
}

function walk(node, fn) {
    for (const child of node.children) {
        fn(child);
        walk(child, fn);
    }
}

function declarations(node) {
    return node.declarations
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean)
        .map((d) => {
            const i = d.indexOf(':');
            return i === -1 ? null : [d.slice(0, i).trim().toLowerCase(), norm(d.slice(i + 1))];
        })
        .filter(Boolean);
}

function ancestors(node) {
    const out = [];
    for (let p = node.parent; p; p = p.parent) out.push(p);
    return out;
}

function insideAtRule(node, name) {
    return ancestors(node).some((a) => a.prelude.startsWith(name));
}

function isSelectorRule(node) {
    return node.prelude !== '' && !node.prelude.startsWith('@') && !insideAtRule(node, '@keyframes');
}

// Selector lists split on top-level commas only, so `:is(a, b)` stays whole.
function splitSelectors(list) {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of list) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && depth === 0) { out.push(norm(cur)); cur = ''; } else cur += ch;
    }
    if (norm(cur)) out.push(norm(cur));
    return out;
}

function setsAnimationNone(node) {
    return declarations(node).some(([p, v]) => (p === 'animation' || p === 'animation-name') && v === 'none');
}

function animates(node) {
    return declarations(node).some(([p, v]) => (p === 'animation' || p === 'animation-name') && v !== 'none');
}

// ── Check 1: data-anim never gates a .bf- rule ────────────────────────────
const DATA_ANIM_ON_BF = /\[data-anim[^\]]*\][^{]*\.bf-/;

export function dataAnimHits(css) {
    return stripComments(css).match(new RegExp(DATA_ANIM_ON_BF.source, 'g')) || [];
}

// ── Check 2: reduced-motion counterparts ──────────────────────────────────
function reducedMotionSelectorsWithAnimationNone(root) {
    const found = new Set();
    for (const block of root.children) {
        if (block.prelude !== REDUCED_MOTION) continue;
        walk(block, (rule) => {
            if (!isSelectorRule(rule) || !setsAnimationNone(rule)) return;
            splitSelectors(rule.prelude).forEach((s) => found.add(s));
        });
    }
    return found;
}

export function animatedBuilderSelectorsWithoutCounterpart(css) {
    const root = parseBlocks(css);
    const covered = reducedMotionSelectorsWithAnimationNone(root);
    const missing = [];
    walk(root, (rule) => {
        if (!isSelectorRule(rule) || insideAtRule(rule, '@media') || !animates(rule)) return;
        for (const sel of splitSelectors(rule.prelude)) {
            if (!/\.bf-|\[data-build/.test(sel)) continue;
            if (!covered.has(sel)) missing.push(sel);
        }
    });
    return missing;
}

export function reducedMotionCoverageFor(css, token) {
    const covered = reducedMotionSelectorsWithAnimationNone(parseBlocks(css));
    return [...covered].filter((s) => s.includes(token));
}

// ── Check 3: nothing tweens transform on the React Flow node wrapper ──────
const MOVING_PROPS = /\b(transform|translate|scale|rotate)\b/;
const EASING = /^(ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end|cubic-bezier\(|steps\(|linear\()/;
const TIME = /^-?[\d.]+m?s$/;

function subjectCompound(selector) {
    // Last compound of the selector: after the final combinator. Pseudo-class
    // arguments never contain combinators in this stylesheet.
    return selector.split(/\s*[>+~]\s*|\s+/).filter(Boolean).pop() || '';
}

function targetsNodeWrapper(selector) {
    return /\.react-flow__node(?![\w-])/.test(subjectCompound(selector));
}

function transitionMovesTransform(value) {
    return value.split(',').some((item) => {
        const tokens = norm(item).split(' ').filter(Boolean);
        const props = tokens.filter((t) => !TIME.test(t) && !EASING.test(t) && !/^(allow-discrete|normal)$/.test(t));
        // A shorthand with no property named transitions `all`.
        if (props.length === 0) return true;
        return props.some((p) => p === 'all' || MOVING_PROPS.test(p));
    });
}

function keyframesTouchingMovement(root) {
    const names = new Set();
    walk(root, (node) => {
        if (!node.prelude.startsWith('@keyframes')) return;
        const name = node.prelude.split(/\s+/)[1];
        let moves = false;
        walk(node, (frame) => {
            if (declarations(frame).some(([p]) => MOVING_PROPS.test(p))) moves = true;
        });
        if (moves) names.add(name);
    });
    return names;
}

export function nodeWrapperMotionViolations(css) {
    const root = parseBlocks(css);
    const movingKeyframes = keyframesTouchingMovement(root);
    const violations = [];
    walk(root, (rule) => {
        if (!isSelectorRule(rule)) return;
        const subjects = splitSelectors(rule.prelude).filter(targetsNodeWrapper);
        if (subjects.length === 0) return;
        for (const [prop, value] of declarations(rule)) {
            if ((prop === 'transition' || prop === 'transition-property') && transitionMovesTransform(value)) {
                violations.push(`${subjects.join(', ')} { ${prop}: ${value} }`);
            }
            if (prop === 'animation' || prop === 'animation-name') {
                const named = value.split(/[\s,]+/).filter((t) => movingKeyframes.has(t));
                if (named.length) violations.push(`${subjects.join(', ')} { ${prop}: ${value} } → @keyframes ${named.join(', ')} moves`);
            }
        }
    });
    return violations;
}

// ── The stylesheet ────────────────────────────────────────────────────────
describe('index.css — builder canvas motion', () => {
    it('never gates a .bf- rule on [data-anim] (that attribute is the glass sheen level, default off)', () => {
        expect(dataAnimHits(CSS)).toEqual([]);
    });

    it('zeroes each of the design\'s motion selectors under prefers-reduced-motion', () => {
        for (const token of ['.bf-step-in', '[data-build=fresh]', '[data-build=touched]', '[data-build=live]', '.bf-edge-draw']) {
            expect(reducedMotionCoverageFor(CSS, token), `${token} has no animation: none inside ${REDUCED_MOTION}`).not.toEqual([]);
        }
    });

    it('gives every animated .bf-* / [data-build] selector a verbatim reduced-motion counterpart', () => {
        expect(animatedBuilderSelectorsWithoutCounterpart(CSS)).toEqual([]);
    });

    it('never transitions or animates transform on .react-flow__node itself', () => {
        expect(nodeWrapperMotionViolations(CSS)).toEqual([]);
    });

    it('declares the choreography keyframes the cards and edges are stamped with', () => {
        const root = parseBlocks(CSS);
        const names = new Set();
        walk(root, (n) => { if (n.prelude.startsWith('@keyframes')) names.add(n.prelude.split(/\s+/)[1]); });
        for (const k of ['bfEdgeDraw', 'bfCardIn', 'bfRingDissolve', 'bfTilePop', 'bfTextIn', 'bfSubWipe', 'bfTouchWash', 'bfLivePulse', 'bfPingTick', 'bfWaitBar', 'bfRibbonPick', 'bfFlyLand', 'bfSpotBreathe', 'bfCaret']) {
            expect(names.has(k), `@keyframes ${k} missing`).toBe(true);
        }
    });

    it('marks the live card with the accent outline only when no run status is on it', () => {
        const root = parseBlocks(CSS);
        let live = null;
        walk(root, (n) => { if (n.prelude === '[data-build=live]:not([data-status])' && !insideAtRule(n, '@media')) live = n; });
        expect(live, 'live selector missing').not.toBeNull();
        const decls = Object.fromEntries(declarations(live));
        expect(decls.outline).toBe('2px solid var(--accent)');
        expect(decls['outline-offset']).toBe('3px');
        expect(decls.animation).toMatch(/^bfLivePulse 2\.4s /);
    });
});

// ── The scanners are not vacuous ──────────────────────────────────────────
// Each check is run against a fixture that breaks the rule, so a green pass
// on the real file means "looked and found nothing", not "looked at nothing".
describe('index.css motion guard — the scanners catch an offender', () => {
    it('sees a data-anim gate on a .bf- class, and not a comment about one', () => {
        expect(dataAnimHits('[data-anim="off"] .bf-step-in { animation: none; }')).toHaveLength(1);
        expect(dataAnimHits('/* [data-anim="off"] .bf-step-in used to live here */ .bf-x { animation: a 1s; }')).toEqual([]);
        expect(dataAnimHits('[data-anim="off"] .wallpaper-layer::before { animation: none; }')).toEqual([]);
    });

    it('reports an animated .bf- selector without a verbatim reduced-motion counterpart', () => {
        const css = `
            .bf-a, .bf-b { animation: x 1s both; }
            [data-build=fresh] .bf-c { animation: y 1s; }
            .bf-static { color: red; }
            @media (prefers-reduced-motion: reduce) {
                .bf-a { animation: none; }
                [data-build=fresh] .bf-c { animation: none; clip-path: none; }
            }`;
        expect(animatedBuilderSelectorsWithoutCounterpart(css)).toEqual(['.bf-b']);
    });

    it('reports a transition or a moving keyframe on the node wrapper, but not on a descendant', () => {
        const css = `
            @keyframes glide { to { transform: translateX(4px); } }
            @keyframes fade { to { opacity: 0; } }
            .react-flow__node { transition: transform 200ms ease; }
            .react-flow__node.dragging { transition: 200ms; }
            .react-flow__node.selected { animation: glide 1s; }
            .react-flow__node.quiet { animation: fade 1s; transition: opacity 200ms; }
            .react-flow__node .card { transition: transform 200ms; animation: glide 1s; }
            .react-flow__node-toolbar { transition: transform 200ms; }`;
        const v = nodeWrapperMotionViolations(css);
        expect(v).toHaveLength(3);
        expect(v[0]).toContain('.react-flow__node {');
        expect(v[1]).toContain('.react-flow__node.dragging');
        expect(v[2]).toContain('@keyframes glide moves');
    });

    it('parses declarations that share a block with nested rules', () => {
        const root = parseBlocks('.a { color: red; .b { color: blue; } margin: 0; }');
        const a = root.children[0];
        expect(a.prelude).toBe('.a');
        expect(declarations(a)).toEqual([['color', 'red'], ['margin', '0']]);
        expect(a.children[0].prelude).toBe('.b');
    });
});

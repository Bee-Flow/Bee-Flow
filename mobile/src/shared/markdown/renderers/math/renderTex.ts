/**
 * A formula, typeset once. MathJax is not cheap per formula and a streaming
 * answer re-renders its last block on every flush, so results are cached by
 * source (a formula that is re-rendered unchanged is a lookup) with a bound,
 * dropping the oldest first.
 *
 * Null means "show the TeX instead": the engine could not load, or the
 * formula does not parse (MathJax marks it with data-mjx-error — the web's
 * KaTeX shows such a formula's source in red; the phone shows the source).
 */

import { loadMathEngine } from '../lazyModules';
import { fitMathSvg, mathError, type MathSvg } from './mathSvg';

/** The formula size: KaTeX sets math at 1.21em of the surrounding text. */
export const MATH_SCALE = 1.21;

const LIMIT = 300;
const cache = new Map<string, string | null>();

function typeset(tex: string, display: boolean): string | null {
    const key = `${display ? 'D' : 'I'}${tex}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const engine = loadMathEngine();
    let svg: string | null = null;
    try {
        svg = engine ? engine.texToSvg(tex, display) : null;
    } catch {
        svg = null;
    }
    if (svg && mathError(svg)) svg = null;
    if (cache.size >= LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, svg);
    return svg;
}

export function renderTex(tex: string, display: boolean, textSize: number): MathSvg | null {
    const svg = tex.trim() ? typeset(tex, display) : null;
    return svg ? fitMathSvg(svg, textSize * MATH_SCALE) : null;
}

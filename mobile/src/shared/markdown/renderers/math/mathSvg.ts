/**
 * MathJax's SVG, made fit for react-native-svg.
 *
 * MathJax sizes its root in `ex` and lowers it with a CSS vertical-align,
 * neither of which a native SvgXml understands. Its viewBox, though, is in
 * a fixed 1000 units per em with the baseline at y = 0, so the pixel size and
 * the depth below the baseline follow from the viewBox and the font size
 * alone. The root's size and style attributes are dropped and handed to the
 * view instead.
 */

export interface MathSvg {
    xml: string;
    width: number;
    height: number;
    /** Pixels below the baseline — how far an inline formula hangs under the text. */
    depth: number;
}

const VIEW_BOX = /viewBox="(-?[\d.]+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)"/;
const ROOT_TAG = /^<svg\b[^>]*>/;

/** MathJax's own verdict on a formula it could not parse, or null. */
export function mathError(svg: string): string | null {
    return /data-mjx-error="([^"]*)"/.exec(svg)?.[1] ?? null;
}

export function fitMathSvg(svg: string, fontSize: number): MathSvg | null {
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- ROOT_TAG is anchored and its [^>]* stops at the first >; each [\d.]+ in VIEW_BOX is followed by a literal it cannot match, so both run in linear time
    const root = ROOT_TAG.exec(svg)?.[0];
    const box = root ? VIEW_BOX.exec(root) : null;
    if (!root || !box) return null;
    const [, , minY, w, h] = box.map(Number) as [number, number, number, number, number];
    if (!(w > 0) || !(h > 0)) return null;
    const scale = fontSize / 1000;
    const cleanRoot = root.replace(/\s(?:style|width|height)="[^"]*"/g, '');
    return {
        xml: cleanRoot + svg.slice(root.length),
        width: w * scale,
        height: h * scale,
        depth: Math.max(0, (minY + h) * scale),
    };
}

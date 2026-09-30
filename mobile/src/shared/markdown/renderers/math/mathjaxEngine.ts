/**
 * TeX to SVG with MathJax 3: its TeX input, its SVG output and its DOM-free
 * lite adaptor — no WebView, no browser. The only module that imports
 * mathjax-full, and only ever reached through lazyModules.ts, so the engine
 * (about 1.8 MB of Hermes bytecode, most of it glyph outlines) is initialised
 * the first time an answer holds a formula, never at start-up.
 *
 * The packages are the ones the web's KaTeX covers in practice: AMS
 * environments (matrices, cases, aligned), \boldsymbol, \color, \cancel and
 * bra-ket notation, with `noundefined` so an unknown macro prints in red
 * instead of failing the whole formula. fontCache 'none' writes each glyph as
 * a plain path: react-native-svg then never has to resolve a <use> reference.
 */

import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import 'mathjax-full/js/input/tex/ams/AmsConfiguration.js';
import 'mathjax-full/js/input/tex/base/BaseConfiguration.js';
import 'mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js';
import 'mathjax-full/js/input/tex/braket/BraketConfiguration.js';
import 'mathjax-full/js/input/tex/cancel/CancelConfiguration.js';
import 'mathjax-full/js/input/tex/color/ColorConfiguration.js';
import 'mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js';
import 'mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { SVG } from 'mathjax-full/js/output/svg.js';

export const TEX_PACKAGES = ['base', 'ams', 'newcommand', 'noundefined', 'boldsymbol', 'color', 'cancel', 'braket'];

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

const document = mathjax.document('', {
    InputJax: new TeX({ packages: TEX_PACKAGES }),
    OutputJax: new SVG({ fontCache: 'none' }),
});

/** The formula as an `<svg>` string (MathJax's own units: 1000 per em). */
export function texToSvg(tex: string, display: boolean): string {
    return adaptor.innerHTML(document.convert(tex, { display }));
}

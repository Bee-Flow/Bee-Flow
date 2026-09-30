/**
 * The heavy renderers, required on first use.
 *
 * Metro puts every module in the one bundle, but Hermes only runs a module's
 * body when something requires it. A plain `import` at the top of the
 * Markdown tree would run MathJax's glyph tables, highlight.js's seventeen
 * grammars, dagre and the chart code on every cold start, for answers that
 * mostly hold none of them. Each loader here runs its module the first time a
 * block needs it and remembers the result.
 *
 * A loader answers null when its module fails to load — an engine that throws
 * on this device, or one taken out of the build — and every caller then shows
 * the block's source instead (the TeX as monospace, the code unhighlighted,
 * the chart or diagram as its code block), so a missing engine costs polish,
 * never content.
 */

/* eslint-disable @typescript-eslint/no-require-imports -- inline requires are what makes these lazy; see above */

function once<T>(load: () => T): () => T | null {
    let state: { value: T | null } | null = null;
    return () => {
        if (!state) {
            try {
                state = { value: load() };
            } catch {
                state = { value: null };
            }
        }
        return state.value;
    };
}

export const loadMathEngine = once(() => require('./math/mathjaxEngine') as typeof import('./math/mathjaxEngine'));

export const loadHighlighter = once(() => require('./code/hljsEngine') as typeof import('./code/hljsEngine'));

export const loadChart = once(() => require('./chart/ChartBlock') as typeof import('./chart/ChartBlock'));

export const loadMermaid = once(() => require('./mermaid/MermaidBlock') as typeof import('./mermaid/MermaidBlock'));

export const loadResearch = once(() => require('./research/ResearchBlock') as typeof import('./research/ResearchBlock'));

export const loadTestReport = once(
    () => require('./testReport/TestReportBlock') as typeof import('./testReport/TestReportBlock'),
);

export const loadPage = once(() => require('./page/PageBlock') as typeof import('./page/PageBlock'));

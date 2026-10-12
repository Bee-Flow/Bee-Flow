'use strict';

/**
 * What a form journey's closing page can be turned into (BFSF-419).
 *
 * The closing page is usually the automation's whole result: a blog post, a
 * summary, an analysis, sitting as markdown in the ending's `description`.
 * The visitor can keep it as a notebook, a webpage, or a Word/PDF download.
 * Everything here starts from the ending the RUN recorded, never from text the
 * page sends back: a visitor saves exactly what their own journey produced,
 * and the routes cannot be used to write or render arbitrary content.
 *
 * Pure apart from the lazy `marked` require, so it is tested on its own
 * (formResult.test.js); the routes in routes/automation/formPublic.js do the
 * scoping (token → session → journey) and the writes.
 */

const { sanitizeContentForExport, escapeHtml } = require('../templates/exportTemplate');
const automationGraph = require('./automationGraph');

/**
 * The closing page, if the automation ran one. `form_page` steps with
 * mode:'ending' record their rendered config; the LAST one on the final run
 * wins, because that is the screen the visitor's journey ended on.
 */
function endingFrom(steps) {
    for (let i = (steps || []).length - 1; i >= 0; i--) {
        const out = steps[i]?.output;
        if (out && out.mode === 'ending' && out.form) return out.form;
    }
    return null;
}

/**
 * `{ title, markdown }` of a closing page, or null when it has no text worth
 * keeping. The title is the page's own heading; the caller falls back to the
 * form's name when it is empty.
 */
function resultOf(ending) {
    const markdown = typeof ending?.description === 'string' ? ending.description.trim() : '';
    if (!markdown) return null;
    const title = typeof ending?.title === 'string' ? ending.title.trim() : '';
    return { title, markdown };
}

/**
 * Markdown → HTML that is safe to store and render elsewhere.
 *
 * Raw HTML inside the markdown is ESCAPED, not passed through: the form page
 * renders the same text with react-markdown and no raw-HTML plugin, so what
 * the visitor saw had none either. What they keep should look like what they
 * saw, and model output is not markup we want to carry into a notebook or a
 * page. sanitizeContentForExport then removes active URL schemes
 * (`[x](javascript:…)`) and remote image loads.
 */
function markdownToSafeHtml(markdown) {
    const { Marked } = require('marked');
    const md = new Marked({ gfm: true, breaks: false, async: false });
    md.use({ renderer: { html: (token) => escapeHtml(token.text || '') } });
    return sanitizeContentForExport(md.parse(String(markdown || '')));
}

/** The stylesheet of a saved result page: a readable article, nothing more. */
const WEBPAGE_CSS = `:root {
    --text: #1f2937;
    --muted: #6b7280;
    --border: #e5e7eb;
    --accent: #0f766e;
    --surface: #ffffff;
}
* { box-sizing: border-box; }
body {
    margin: 0;
    background: var(--surface);
    color: var(--text);
    font: 17px/1.65 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
h1, h2, h3 { line-height: 1.25; margin: 2rem 0 0.75rem; }
h1 { font-size: 2rem; margin-top: 0; }
p, ul, ol, table, blockquote { margin: 0 0 1rem; }
a { color: var(--accent); }
img { max-width: 100%; height: auto; }
blockquote { border-left: 3px solid var(--border); padding-left: 1rem; color: var(--muted); }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--border); padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
th { background: #f9fafb; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.9em; }
pre { overflow-x: auto; padding: 1rem; background: #f9fafb; border: 1px solid var(--border); }
`;

/**
 * The two slots of a webpage that shows the result: a complete `index.html`
 * (the vanilla framework's entry point, linking `style.css` the way the
 * builder's own pages do) and that stylesheet. The title becomes the page's
 * `<h1>` unless the text already opens with a heading of its own.
 */
function webpageSlots({ title, markdown }) {
    const body = markdownToSafeHtml(markdown);
    const heading = title && !/^\s*<h1[\s>]/i.test(body) ? `<h1>${escapeHtml(title)}</h1>\n` : '';
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || 'Result')}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<main>
${heading}${body}
</main>
</body>
</html>
`;
    return { html, css: WEBPAGE_CSS };
}

/**
 * The AI-content marking request for a download (EU AI Act Art. 50(2)), or
 * null when the automation has no AI step.
 *
 * Deliberately broader than generate_document's per-step tracing: any AI step
 * in the automation counts. An over-marked document carries one footer line too
 * many; an unmarked AI document is the compliance failure. `resolveMarking`
 * still decides whether this organisation marks at all.
 */
function aiStepsOf(definition) {
    const steps = [];
    automationGraph.walkSteps(definition || {}, (s) => { if (s?.id && automationGraph.isAiStep(s)) steps.push(s); });
    if (!steps.length) return null;
    const hinted = steps.find(s => typeof s.provider === 'string' || typeof s.model === 'string');
    const provider = hinted
        ? String(hinted.provider || String(hinted.model).split(/[/:]/)[0]).trim().toLowerCase() || null
        : null;
    return { aiStepIds: steps.map(s => s.id), provider };
}

/** A safe download filename from the result's title. */
function resultFilename(title, extension) {
    const base = String(title || 'result').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    return `${base || 'result'}.${extension}`;
}

module.exports = { endingFrom, resultOf, markdownToSafeHtml, webpageSlots, aiStepsOf, resultFilename, WEBPAGE_CSS };

// @typecheck
/**
 * A PAGE (doc_type 'page') on paper.
 *
 * A page is written in the rich-text editor, not designed in the frame, so it
 * has no stylesheet of its own (its `css` slot stays empty). It prints through
 * the same composer as every document (services/documentCompose.js: base
 * geometry, then the organisation's house style, then a sheet), and the sheet
 * is this one: typography for what the editor writes (headings, lists, task
 * lists, quotes, code, tables, charts' data tables, images), in the house
 * style's --doc-* variables so a page wears the letterhead's colours and font
 * like any designed document.
 *
 * `forCompose(doc)` is the document the composer (and the PDF renderer) is
 * handed: the stored page with this sheet in its css slot. The store never
 * holds it, so a better sheet here restyles every page ever written.
 */

'use strict';

const PAGE_DOC_TYPE = 'page';

const PAGE_CSS = `
body { font-size: 11pt; line-height: 1.6; }
h1 { font-size: 20pt; margin: 0 0 .5em; color: var(--doc-accent); }
h2 { font-size: 15pt; margin: 1.1em 0 .4em; color: var(--doc-accent); }
h3 { font-size: 12.5pt; margin: 1em 0 .35em; }
h4, h5, h6 { font-size: 11pt; margin: .9em 0 .3em; }
p { margin: 0 0 .65em; }
ul, ol { margin: 0 0 .7em; padding-left: 1.4em; }
li { margin: .15em 0; }
li > p { margin: 0; }
ul[data-type="taskList"] { list-style: none; padding-left: .2em; }
li[data-type="taskItem"]::before { content: "\\2610"; display: inline-block; width: 1.3em; }
li[data-type="taskItem"][data-checked="true"]::before { content: "\\2611"; }
blockquote { margin: 0 0 .8em; padding: .2em 0 .2em .9em; border-left: 3px solid var(--doc-accent); color: var(--doc-muted); }
pre { margin: 0 0 .8em; padding: .6em .8em; background: #f5f6f8; border-radius: 4px; font-size: 9.5pt; white-space: pre-wrap; }
code { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: .92em; }
hr { border: 0; border-top: 1px solid #d9dce1; margin: 1.2em 0; }
table { margin: 0 0 .9em; font-size: 10pt; }
th, td { border: 1px solid #d9dce1; padding: 4px 7px; text-align: left; vertical-align: top; }
th { background: #f5f6f8; font-weight: 600; }
figure { margin: 0 0 .9em; }
figcaption { font-size: 9pt; color: var(--doc-muted); margin-bottom: .3em; }
img { display: block; margin: .3em 0 .8em; }
mark { background: #fff3a3; padding: 0 .1em; }
a { color: var(--doc-accent); text-decoration: underline; }
div[data-type="mermaid-diagram"] { display: none; }
`.trim();

/** @param {{ docType?: string }|null|undefined} doc */
function isPage(doc) {
    return doc?.docType === PAGE_DOC_TYPE;
}

/**
 * The document the composer should compose: a page with its sheet, anything
 * else as it is.
 *
 * @template {{ docType?: string, css?: string }} T
 * @param {T} doc
 * @returns {T}
 */
function forCompose(doc) {
    return isPage(doc) ? { ...doc, css: PAGE_CSS } : doc;
}

module.exports = { PAGE_DOC_TYPE, PAGE_CSS, isPage, forCompose };

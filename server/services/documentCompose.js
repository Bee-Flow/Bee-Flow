/**
 * Document compose — the stripped-down sibling of the webpage composer.
 *
 * utils/composeWebpageDocument.js builds a small application: it injects the
 * auth helper, the SQLite shim, the AI / automations / integrations / tables
 * bridges and the bf-element runtime, because a webpage is a thing that RUNS.
 * A document is a thing that PRINTS. So none of that is here, and the
 * difference is not a matter of degree:
 *
 *   • No JavaScript slot at all. The model cannot author script for a
 *     document, and any script that arrives in the markup anyway is removed.
 *   • No bridges, so no token, so nothing to act as the author with.
 *   • No network. Every remote url — <img src>, CSS url(), @import — is
 *     stripped, in the markup AND in the stylesheet. This matters twice over:
 *     the PDF path loads this HTML into a real Chromium ON THE SERVER, where a
 *     remote fetch is an SSRF primitive, and this is a privacy product, where
 *     "the renderer fetched a tracking pixel from the customer's invoice" is a
 *     data leak with a straight face. data: URLs survive, so an embedded logo
 *     still works.
 *
 * THREE STYLESHEET LAYERS, in cascade order: the base print geometry below,
 * then the organisation's house style (core/documents/documentHouseStyle.js —
 * custom properties only, skipped entirely when the document opts out), then
 * the document's own sheet, which can override either.
 *
 * WHAT THE SLOTS HOLD (see stores/documentStore.js): `bodyHtml` is body markup
 * only, `css` is the stylesheet. This module is the only thing that knows how
 * to turn that pair into a document, and it is used by BOTH the editor preview
 * and the PDF renderer — one composer, so what you hand-edit on screen is what
 * comes out of the printer.
 */

const createDOMPurify = require('dompurify');
const { JSDOM } = require('jsdom');

let purifyInstance = null;
function getPurify() {
    if (purifyInstance) return purifyInstance;
    purifyInstance = createDOMPurify(new JSDOM('').window);
    return purifyInstance;
}

/**
 * Tags that have no business in a printed document and are load-bearing for an
 * attacker: anything that executes, embeds, navigates or collects. `style` is
 * forbidden in the BODY too — the stylesheet has its own slot, and a <style>
 * smuggled into the markup is how you would reach the rules below.
 */
const FORBID_TAGS = Object.freeze([
    'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
    'form', 'input', 'button', 'textarea', 'select', 'option',
    'base', 'meta', 'link', 'style', 'noscript', 'template',
    'audio', 'video', 'source', 'track', 'canvas', 'portal',
]);

const FORBID_ATTR = Object.freeze(['srcset', 'ping', 'formaction', 'background']);

/**
 * Sanitise the body markup.
 *
 * DOMPurify handles the hard parts (namespace confusion, mXSS, event handlers,
 * javascript: URLs) far better than a regex pass could. What it does NOT do is
 * take a position on remote resource loads — those are legal HTML — so the
 * hook below removes them afterwards.
 */
function sanitizeDocumentBody(html) {
    const raw = String(html ?? '');
    if (!raw.trim()) return '';
    const purify = getPurify();

    // Registered per call and removed again: DOMPurify hooks are global to the
    // instance, and this module shares its singleton with nothing, but leaving
    // a hook installed would still surprise the next caller.
    const stripRemote = (node) => {
        for (const attr of ['src', 'href', 'xlink:href', 'poster', 'data']) {
            if (!node.hasAttribute || !node.hasAttribute(attr)) continue;
            const value = String(node.getAttribute(attr) || '').trim();
            if (/^(https?:)?\/\//i.test(value)) {
                // An <a href> is inert on paper and harmless in the sandboxed
                // preview — it fetches nothing until somebody clicks. Anything
                // that the RENDERER would fetch on its own is what goes.
                if (node.tagName === 'A' && attr === 'href') continue;
                node.removeAttribute(attr);
            }
        }
        // Inline styles can fetch too.
        if (node.hasAttribute && node.hasAttribute('style')) {
            node.setAttribute('style', sanitizeCssText(node.getAttribute('style')));
        }
    };

    purify.addHook('afterSanitizeAttributes', stripRemote);
    try {
        return purify.sanitize(raw, {
            FORBID_TAGS: [...FORBID_TAGS],
            FORBID_ATTR: [...FORBID_ATTR],
            // The markup is a document fragment, not a whole page: keep it that
            // way so what we store stays round-trippable with body.innerHTML.
            WHOLE_DOCUMENT: false,
            ADD_TAGS: ['#comment'],
            ALLOW_DATA_ATTR: true,
        });
    } finally {
        purify.removeHook('afterSanitizeAttributes');
    }
}

/**
 * Sanitise a stylesheet (or a style="" attribute value).
 *
 * DOMPurify does not parse CSS, so this is hand-rolled — but the surface is
 * small and each rule is here for a named reason:
 *
 *   </style      — the one true escape hatch. CSS is emitted inside a <style>
 *                  block, and the HTML parser ends that element at the literal
 *                  `</style`, so a stylesheet containing it could close its own
 *                  tag and open a <script>. Defanged the way the webpage
 *                  composer defangs `</script` in JS.
 *   @import      — a remote fetch that the sanitised markup can no longer make.
 *   url(http…)   — ditto, and the usual way a "font" turns into a beacon.
 *   expression() — legacy IE script-in-CSS.
 *   behavior:    /  -moz-binding: — the same idea, other vendors.
 */
function sanitizeCssText(css) {
    let s = String(css ?? '');
    if (!s) return '';
    s = s.replace(/<\/style/gi, '<\\/style');
    s = s.replace(/@import\b[^;]*;?/gi, '');
    s = s.replace(/@charset\b[^;]*;?/gi, '');
    // Keep data: URLs (embedded logos and fonts); drop everything else that
    // names a location. `url()` with no scheme is a relative path, which in a
    // srcdoc/`setContent` page resolves to nothing useful anyway.
    s = s.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match, _q, target) => (
        /^data:/i.test(String(target).trim()) ? match : 'none'
    ));
    s = s.replace(/expression\s*\(/gi, 'void(');
    s = s.replace(/behaviou?r\s*:/gi, '_disabled:');
    s = s.replace(/-moz-binding\s*:/gi, '_disabled:');
    return s;
}

/**
 * The house stylesheet every document starts from — paper geometry and the
 * print rules nobody remembers until they have printed twelve pages.
 *
 * It is emitted BEFORE the author's CSS, so every rule here is a default the
 * document can override (including @page: an invoice that wants Letter, or no
 * margin because its own header bleeds to the edge, just says so).
 *
 * The screen block is what makes the editor feel like a document rather than a
 * web page: a real A4 sheet on a grey desk. It is @media screen only, so it
 * cannot leak into the PDF, where @page owns the margins instead.
 */
const BASE_CSS = `
/* The --doc-* vocabulary, ALWAYS defined.
 *
 * The organisation's house style overrides these; a document that opted out
 * still gets them. That is not a nicety — it is what stops an opt-out breaking
 * a document. A stylesheet that writes \`background: var(--doc-accent); color:
 * #fff\` against an UNDEFINED variable is invalid at computed-value time, so
 * the background falls back to transparent and the table header becomes white
 * text on white paper. Defining the fallbacks here means opting out gives a
 * neutral document rather than an unreadable one, and the model can use the
 * variables unconditionally without knowing whether an org has a letterhead. */
:root {
  --doc-accent: #1f2937;
  --doc-ink: #1a1d21;
  --doc-muted: #6b7280;
  --doc-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --doc-logo-width: 24mm;
}
@page { size: A4; margin: 18mm 16mm; }
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: var(--doc-font);
  font-size: 10.5pt;
  line-height: 1.5;
  color: var(--doc-ink);
  background: #ffffff;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
h1, h2, h3, h4, h5, h6 { break-after: avoid-page; page-break-after: avoid; margin: 0 0 .4em; line-height: 1.25; }
p { margin: 0 0 .7em; }
table { border-collapse: collapse; width: 100%; }
/* Repeat the header row when a table of invoice lines runs over a page. */
thead { display: table-header-group; }
tfoot { display: table-footer-group; }
tr, img, figure, blockquote { break-inside: avoid; page-break-inside: avoid; }
img { max-width: 100%; height: auto; }
a { color: inherit; text-decoration: none; }
/* A long IBAN or order reference must wrap rather than run off the sheet. */
td, th { overflow-wrap: anywhere; }

@media screen {
  html { background: #f1f2f4; }
  body {
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto;
    padding: 18mm 16mm;
    box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 8px 28px rgba(0,0,0,.08);
  }
}
@media print {
  html { background: #ffffff; }
  body { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; }
}
`.trim();

/**
 * The hand-editing bridge. Injected for the editor preview ONLY — never for
 * the PDF, which must render exactly the stored markup and nothing else.
 *
 * It lives in <head> deliberately: `document.body.innerHTML` is what gets sent
 * back and stored, so anything this script leaves in <body> would be saved into
 * the document and re-injected on the next load, compounding every time.
 *
 * The contract with the parent frame:
 *   parent → frame  { __beeflowDocEdit: true, editing: bool }
 *   frame  → parent { __beeflowDocDirty: true, html }      (debounced)
 *   frame  → parent { __beeflowDocReady: true }
 */
function buildEditBridgeScript() {
    return `<script>(function(){
  var DEBOUNCE_MS = 400;
  var timer = null;
  function bodyContent() {
    var copy = document.body.cloneNode(true);
    copy.querySelectorAll('[data-doc-token]').forEach(function(el){el.replaceWith(document.createTextNode(el.textContent));});
    return copy.innerHTML.replace(/<!--bf-template:([A-Za-z0-9+/=]+)-->/g,function(_m,encoded){return atob(encoded);});
  }
  function protectTokens() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    var nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function(node) {
      if (node.parentElement.closest('[data-doc-token]')) return;
      var re = /\\{\\{[^{}]+\\}\\}/g; var text = node.textContent; var match; var last = 0; var fragment = document.createDocumentFragment();
      while ((match = re.exec(text))) {
        fragment.appendChild(document.createTextNode(text.slice(last,match.index)));
        var token = document.createElement('span'); token.setAttribute('data-doc-token','true'); token.setAttribute('contenteditable','false');
        token.textContent = match[0]; token.style.background = '#e0e7ff'; token.style.color = '#312e81'; token.style.borderRadius = '3px'; fragment.appendChild(token);
        last = match.index + match[0].length;
      }
      if (last) {fragment.appendChild(document.createTextNode(text.slice(last)));node.replaceWith(fragment);}
    });
  }
  function push(requestId) {
    try {
      parent.postMessage({ __beeflowDocDirty: true, html: bodyContent(), requestId: requestId }, '*');
    } catch (_) {}
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    // The parent debounces persistence. Report edits immediately so recovery
    // survives closing or replacing the chat panel before an iframe timer fires.
    push();
  }
  function setEditing(on) {
    document.body.setAttribute('contenteditable', on ? 'true' : 'false');
    document.body.style.outline = 'none';
    if (on) protectTokens();
    if (on) { try { document.body.focus({ preventScroll: true }); } catch (_) {} }
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e && e.data;
    if (d && d.__beeflowDocFlush) {if(timer) clearTimeout(timer);push(d.requestId);return;}
    if (d && d.__beeflowDocInsert && typeof d.key === 'string' && /^[A-Za-z0-9_.-]+$/.test(d.key)) {
      setEditing(true); document.body.focus();
      if (Array.isArray(d.fields) && d.fields.length <= 100 && d.fields.every(function(key){return typeof key === 'string' && /^[A-Za-z0-9_.-]+$/.test(key);})) {
        var fields = d.fields.length ? d.fields : ['this'];
        var start = '<!--bf-template:'+btoa('{{#each '+d.key+'}}')+'-->';
        var end = '<!--bf-template:'+btoa('{{/each}}')+'-->';
        document.execCommand('insertHTML',false,'<table><thead><tr>'+fields.map(function(key){return '<th>'+key+'</th>';}).join('')+'</tr></thead><tbody>'+start+'<tr>'+fields.map(function(key){return '<td>{{'+key+'}}</td>';}).join('')+'</tr>'+end+'</tbody></table>');
      } else document.execCommand('insertText',false,'{{'+d.key+'}}');
      protectTokens();push();return;
    }
    if (d && d.__beeflowDocSection && typeof d.id === 'string') {
      var target = Array.from(document.querySelectorAll('[data-doc-section]')).find(function(el){return el.getAttribute('data-doc-section')===d.id;});
      if(target) target.scrollIntoView({behavior:'smooth'});return;
    }
    if (!d || d.__beeflowDocEdit !== true) return;
    setEditing(!!d.editing);
  });
  document.addEventListener('input', schedule, true);
  // execCommand edits (paste, formatting) do not always raise 'input' in every
  // engine; a blur is the other moment the text is known to have settled.
  document.addEventListener('blur', function(){ if (timer) { clearTimeout(timer); timer = null; } push(); }, true);
  // Paste as PLAIN TEXT. Pasting a block of styled HTML out of Word or a
  // browser is the fastest way to wreck a document's layout, and it would
  // smuggle markup straight past the server sanitiser into the next save.
  document.addEventListener('paste', function (e) {
    if (document.body.getAttribute('contenteditable') !== 'true') return;
    e.preventDefault();
    var text = (e.clipboardData || window.clipboardData).getData('text/plain');
    try { document.execCommand('insertText', false, text); } catch (_) {}
  }, true);
  // A link inside a contenteditable document is a navigation waiting to happen.
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a');
    if (a) e.preventDefault();
  }, true);
  document.addEventListener('DOMContentLoaded', function () {
    setEditing(false);
    try { parent.postMessage({ __beeflowDocReady: true }, '*'); } catch (_) {}
  });
})();<\/script>`;
}

/**
 * Compose the stored slots into one complete, self-contained HTML document.
 *
 * @param {object} doc              { bodyHtml, css, name }
 * @param {object} [options]
 * @param {'preview'|'print'} [options.mode='print']  preview injects the edit bridge
 * @param {boolean} [options.sanitize=true]  only ever false in tests
 * @param {string} [options.houseStyleCss]  the org's house-style CSS, sanitised and layered under the document's own
 * @returns {string} a full <!DOCTYPE html> document
 */
function composeDocument({ bodyHtml = '', css = '', name = '', settings = {} } = {}, options = {}) {
    const { mode = 'print', sanitize = true, houseStyleCss = '' } = options;
    // Block markers inside tables must be comments until serialization: an HTML
    // parser otherwise foster-parents their text outside tbody, destroying loops.
    const source = mode === 'preview' ? String(bodyHtml).replace(/\{\{\s*(?:#(?:if|each)\s+[^{}]+|\/(?:if|each)|else)\s*\}\}/g,
        token => `<!--bf-template:${Buffer.from(token).toString('base64')}-->`) : bodyHtml;
    const body = sanitize ? sanitizeDocumentBody(source) : String(source || '');
    const design = settings.design ? require('../core/documents/documentDesign').designCss(settings.design) : '';
    const sheet = (sanitize ? sanitizeCssText(css) : String(css || '')) + '\n' + design;
    // The org's letterhead variables, already built by
    // core/documents/documentHouseStyle.js. Sanitised like any other CSS —
    // it is assembled from stored config, and a logo data: URL is the one
    // url() the sanitiser keeps, which is exactly what it needs.
    const house = houseStyleCss ? sanitizeCssText(houseStyleCss) : '';
    const title = escapeHtml(String(name || 'Document'));
    const bridge = mode === 'preview' ? buildEditBridgeScript() : '';

    // Order is the contract: base geometry, then the org's house style, then
    // the document's own sheet. Each layer can override the one above it, so a
    // one-off in a customer's colours just redeclares --doc-accent and an
    // opted-out document (house === '') is exactly what it was before.
    return `<!DOCTYPE html>
<html lang="${settings.locale === 'en' ? 'en' : 'nl'}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>
${BASE_CSS}
</style>
<style>
${house}
</style>
<style>
${sheet}
</style>
${bridge}
</head>
<body>${body}</body>
</html>`;
}

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

module.exports = {
    composeDocument,
    sanitizeDocumentBody,
    sanitizeCssText,
    BASE_CSS,
    FORBID_TAGS,
    _test: { buildEditBridgeScript, escapeHtml },
};

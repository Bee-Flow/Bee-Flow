/**
 * The hand-editing bridge of a designed document: the script the editor
 * preview carries in its <head> (services/documentCompose.js injects it for
 * `mode: 'preview'` only; the PDF never has it).
 *
 * It runs INSIDE the sandboxed frame (no same origin, CSP: no network), so it
 * talks to the editor only by postMessage, and everything it draws for the
 * editor (other people's section highlights, find and comment highlights) is
 * drawn OUTSIDE <body>: `document.body.innerHTML` is what is saved, and
 * anything left in the body would be stored with the next keystroke.
 *
 * Written as a plain function and serialised with toString(), so it is real,
 * lintable code instead of a string of escaped escapes. It is browser code:
 * not type-checked with the server (no DOM library there), tested in jsdom by
 * documentEditBridge.test.js.
 *
 * THE PROTOCOL (the editor's half is agent-hub/src/pages/documents/canvasBridge.ts)
 *   parent → frame
 *     __beeflowDocEdit {editing}          contenteditable on or off
 *     __beeflowDocFlush {requestId}       report the body now (answered by Dirty with the id)
 *     __beeflowDocInsert {key, fields?}   a {{placeholder}} or a repeating table at the caret
 *     __beeflowDocSection {id}            scroll to a section
 *     __beeflowDocScrollTo {index}        scroll to an outline entry
 *     __beeflowDocFind {query, step}      find: highlight all, move to the next (1) / previous (-1)
 *     __beeflowDocPeers {peers}           [{sectionId, label, colour}] others editing, drawn over their sections
 *     __beeflowDocPatch {sections}        {sectionId: html} changes others made, put in place (sanitised by the server)
 *     __beeflowDocTheme {desk, fit}       the desk colour of the app's theme; fit the sheet to the frame width
 *     __beeflowDocAnchors {anchors, activeId}  comment passages to highlight [{id, quote, sectionId}]
 *     __beeflowDocReveal {quote, sectionId}    scroll a passage into view
 *     __beeflowDocScroll {y}              restore a scroll position after a reload
 *   frame → parent
 *     __beeflowDocReady                   the bridge is up
 *     __beeflowDocDirty {html, requestId?} the body after an edit (or a flush)
 *     __beeflowDocCaret {sectionId}       the caret moved into another section (or none)
 *     __beeflowDocOutline {items}         [{index, level, text, sectionId}] h1–h3 and headingless sections
 *     __beeflowDocStats {words, pages, text}  counts, and the plain text (for comment anchors)
 *     __beeflowDocSelection {anchor|null} the selected passage as a comment anchor
 *     __beeflowDocFound {count, index}    find results
 *     __beeflowDocPatched {applied, missing}
 *     __beeflowDocScrolled {y}
 *     __beeflowDocKey {key}               a shortcut pressed inside the frame (save, find, history, comment, escape, help)
 */

'use strict';

const { bridgeCore, bridgeDraw } = require('./documentEditBridgeParts');
const { bestEffort } = require('../utils/bestEffort');

/* global document, window, parent */
// The bridge is built from three parts that share one object, B, because the
// whole thing is serialised with toString() into one script and each part has
// to be a function of its own (a single function would be 300+ lines).
function bridgeWire(B) {
    var post = B.post;
    var later = B.later;
    var drawPeers = B.drawPeers;
    var reportLater = B.reportLater;
    var style = B.style;
    var bodyContent = B.bodyContent;
    var protectTokens = B.protectTokens;
    var sectionEl = B.sectionEl;
    var outlineNodes = B.outlineNodes;
    var reportOutline = B.reportOutline;
    var reportStats = B.reportStats;
    var reportCaret = B.reportCaret;
    var reportSelection = B.reportSelection;
    var textRanges = B.textRanges;
    var paint = B.paint;
    var reveal = B.reveal;
    var find = B.find;
    var patch = B.patch;
    var fit = B.fit;
    var setEditing = B.setEditing;
    var keyOf = B.keyOf;

    window.addEventListener('message', function (e) {
        if (e.source !== parent) return;
        var d = e && e.data;
        if (!d || typeof d !== 'object') return;
        if (d.__beeflowDocFlush) { post({ __beeflowDocDirty: true, html: bodyContent(), requestId: d.requestId }); return; }
        if (d.__beeflowDocInsert && typeof d.key === 'string' && /^[A-Za-z0-9_.-]+$/.test(d.key)) {
            setEditing(true); document.body.focus();
            if (Array.isArray(d.fields) && d.fields.length <= 100 && d.fields.every(function (/** @type {string} */ key) { return typeof key === 'string' && /^[A-Za-z0-9_.-]+$/.test(key); })) {
                var fields = d.fields.length ? d.fields : ['this'];
                var start = '<!--bf-template:' + window.btoa('{{#each ' + d.key + '}}') + '-->';
                var end = '<!--bf-template:' + window.btoa('{{/each}}') + '-->';
                document.execCommand('insertHTML', false, '<table><thead><tr>' + fields.map(function (/** @type {string} */ key) { return '<th>' + key + '</th>'; }).join('') + '</tr></thead><tbody>' + start + '<tr>' + fields.map(function (/** @type {string} */ key) { return '<td>{{' + key + '}}</td>'; }).join('') + '</tr>' + end + '</tbody></table>');
            } else document.execCommand('insertText', false, '{{' + d.key + '}}');
            protectTokens();
            post({ __beeflowDocDirty: true, html: bodyContent() });
            return;
        }
        if (d.__beeflowDocSection && typeof d.id === 'string') { var target = sectionEl(d.id); if (target) target.scrollIntoView({ behavior: 'smooth' }); return; }
        if (d.__beeflowDocScrollTo) { var node = outlineNodes()[Number(d.index) || 0]; if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        if (d.__beeflowDocFind) { if (typeof d.query === 'string' && d.query) find(d.query.slice(0, 200), Number(d.step) || 1); else { paint('bf-find', []); paint('bf-find-current', []); B.resetFind(); post({ __beeflowDocFound: true, count: 0, index: -1 }); } return; }
        if (d.__beeflowDocPeers) { B.setPeers(Array.isArray(d.peers) ? d.peers.slice(0, 20) : []); drawPeers(); return; }
        if (d.__beeflowDocPatch) { patch(d.sections); return; }
        if (d.__beeflowDocTheme) {
            if (typeof d.desk === 'string' && /^[#(),.%\w\s-]{1,60}$/.test(d.desk)) document.documentElement.style.background = d.desk;
            if (d.fit) { fit(); window.addEventListener('resize', fit); }
            return;
        }
        if (d.__beeflowDocAnchors) {
            var list = Array.isArray(d.anchors) ? d.anchors.slice(0, 200) : [];
            var all = [];
            var active = [];
            list.forEach(function (a) {
                if (!a || typeof a.quote !== 'string' || !a.quote) return;
                var found = textRanges(a.quote, (a.sectionId && sectionEl(a.sectionId)) || document.body)[0];
                if (!found) return;
                (a.id === d.activeId ? active : all).push(found);
            });
            paint('bf-comment', all);
            paint('bf-comment-active', active);
            return;
        }
        if (d.__beeflowDocReveal && typeof d.quote === 'string') {
            var hit = textRanges(d.quote, (d.sectionId && sectionEl(d.sectionId)) || document.body)[0];
            if (hit) reveal(hit);
            return;
        }
        if (d.__beeflowDocScroll) { window.scrollTo(0, Number(d.y) || 0); return; }
        if (d.__beeflowDocEdit === true) setEditing(!!d.editing);
    });

    document.addEventListener('input', function () {
        post({ __beeflowDocDirty: true, html: bodyContent() });
        reportLater();
    }, true);
    // execCommand edits (paste, formatting) do not always raise 'input' in
    // every engine; a blur is the other moment the text is known to have settled.
    document.addEventListener('blur', function () { if (B.isEditing()) post({ __beeflowDocDirty: true, html: bodyContent() }); }, true);
    document.addEventListener('selectionchange', function () { later('caret', 150, function () { reportCaret(); reportSelection(); }); });
    document.addEventListener('keydown', function (e) {
        var key = keyOf(e);
        if (!key) return;
        if (key !== 'escape') e.preventDefault();
        post({ __beeflowDocKey: true, key: key });
    }, true);
    // Paste as PLAIN TEXT: styled HTML out of a word processor wrecks the
    // layout and would smuggle markup past the server sanitiser.
    document.addEventListener('paste', function (e) {
        if (!B.isEditing()) return;
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData('text/plain');
        try { document.execCommand('insertText', false, text); } catch (err) { bestEffort('services/documentEditBridge:bridgeWire', err); /* engine without execCommand */ }
    }, true);
    // A link inside an editable document is a navigation waiting to happen.
    document.addEventListener('click', function (e) {
        var a = e.target && e.target.closest && e.target.closest('a');
        if (a) e.preventDefault();
    }, true);
    window.addEventListener('scroll', function () { later('scroll', 200, function () { drawPeers(); post({ __beeflowDocScrolled: true, y: window.scrollY }); }); });
    window.addEventListener('resize', function () { later('peers', 100, drawPeers); });

    function ready() {
        style();
        setEditing(false);
        reportOutline();
        reportStats();
        post({ __beeflowDocReady: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
    else ready();
}

/** The bridge as the <script> element the preview's <head> carries. */
function buildEditBridgeScript() {
    return `<script>(function () { var B = {}; (${bridgeCore})(B); (${bridgeDraw})(B); (${bridgeWire})(B); })();</script>`;
}

module.exports = { buildEditBridgeScript };

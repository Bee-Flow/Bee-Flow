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

/* global document, window, parent, NodeFilter, CSS, Highlight */
function bridge() {
    var editing = false;
    var lastCaret;
    var lastSelection = null;
    var timers = {};
    var peers = [];
    var findState = { query: '', ranges: [], index: -1 };
    var MM = 96 / 25.4;
    var PAGE_PX = 297 * MM;
    var SHEET_PX = 210 * MM;
    var TONES = ['#0f766e', '#c2410c', '#15803d', '#1d4ed8', '#be123c', '#a16207'];

    function post(message) { try { parent.postMessage(message, '*'); } catch (_) { /* parent gone */ } }
    function later(name, ms, fn) { clearTimeout(timers[name]); timers[name] = setTimeout(fn, ms); }

    function style() {
        var el = document.createElement('style');
        el.setAttribute('data-bf-bridge', '1');
        el.textContent = '[data-doc-token]{background:#dbeafe;color:#1e3a8a;border-radius:3px;padding:0 1px}'
            + '::highlight(bf-find){background:#fde68a}::highlight(bf-find-current){background:#f59e0b;color:#111}'
            + '::highlight(bf-comment){background:rgba(250,204,21,.35)}::highlight(bf-comment-active){background:rgba(250,204,21,.7)}'
            + '.bf-peer{position:absolute;pointer-events:none;border:2px solid;border-radius:4px;z-index:2147483646}'
            + '.bf-peer span{position:absolute;top:-1.6em;left:-2px;font:600 11px/1.4 system-ui,sans-serif;color:#fff;padding:1px 6px;border-radius:4px 4px 4px 0;white-space:nowrap}';
        document.head.appendChild(el);
    }

    function bodyContent() {
        var copy = document.body.cloneNode(true);
        copy.querySelectorAll('[data-doc-token]').forEach(function (el) { el.replaceWith(document.createTextNode(el.textContent)); });
        return copy.innerHTML.replace(/<!--bf-template:([A-Za-z0-9+/=]+)-->/g, function (_m, encoded) { return window.atob(encoded); });
    }

    function protectTokens(root) {
        var walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
        var nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(function (node) {
            if (!node.parentElement || node.parentElement.closest('[data-doc-token]')) return;
            var re = /\{\{[^{}]+\}\}/g;
            var text = node.textContent;
            var match;
            var last = 0;
            var fragment = document.createDocumentFragment();
            while ((match = re.exec(text))) {
                fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
                var token = document.createElement('span');
                token.setAttribute('data-doc-token', 'true');
                token.setAttribute('contenteditable', 'false');
                token.textContent = match[0];
                fragment.appendChild(token);
                last = match.index + match[0].length;
            }
            if (last) { fragment.appendChild(document.createTextNode(text.slice(last))); node.replaceWith(fragment); }
        });
    }

    function sectionOf(node) {
        var el = node && (node.nodeType === 1 ? node : node.parentElement);
        var section = el && el.closest ? el.closest('[data-doc-section]') : null;
        return section ? section.getAttribute('data-doc-section') : null;
    }
    function sectionEl(id) {
        return Array.prototype.find.call(document.body.querySelectorAll('[data-doc-section]'), function (el) { return el.getAttribute('data-doc-section') === id; }) || null;
    }

    function outlineNodes() {
        return Array.prototype.filter.call(document.body.querySelectorAll('h1,h2,h3,[data-doc-section]'), function (el) {
            return !el.hasAttribute('data-doc-section') || !el.querySelector('h1,h2,h3');
        });
    }
    function reportOutline() {
        post({ __beeflowDocOutline: true, items: outlineNodes().map(function (el, index) {
            var isSection = el.hasAttribute('data-doc-section');
            return {
                index: index,
                level: isSection ? 2 : Number(el.tagName.slice(1)),
                text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || (isSection ? el.getAttribute('data-doc-section') : ''),
                sectionId: isSection ? el.getAttribute('data-doc-section') : sectionOf(el),
            };
        }) });
    }
    function reportStats() {
        var text = (document.body.innerText || document.body.textContent || '').replace(/\s+/g, ' ').trim();
        var words = text ? text.split(' ').length : 0;
        var pages = Math.max(1, Math.ceil((document.body.scrollHeight || 0) / PAGE_PX));
        post({ __beeflowDocStats: true, words: words, pages: pages, text: text.slice(0, 200000) });
    }
    function reportLater() { later('outline', 600, function () { reportOutline(); reportStats(); drawPeers(); }); }

    function reportCaret() {
        var sel = document.getSelection();
        var id = sel && sel.rangeCount ? sectionOf(sel.anchorNode) : null;
        if (id !== lastCaret) { lastCaret = id; post({ __beeflowDocCaret: true, sectionId: id }); }
    }

    function blockIndexOf(node) {
        var el = node && (node.nodeType === 1 ? node : node.parentElement);
        while (el && el.parentElement && el.parentElement !== document.body) el = el.parentElement;
        return el && el.parentElement === document.body ? Array.prototype.indexOf.call(document.body.children, el) : 0;
    }
    function reportSelection() {
        var sel = document.getSelection();
        var anchor = null;
        if (sel && sel.rangeCount && !sel.isCollapsed && document.body.contains(sel.anchorNode)) {
            var range = sel.getRangeAt(0);
            var quote = sel.toString().replace(/\s+/g, ' ').trim().slice(0, 500);
            if (quote) {
                var sectionId = sectionOf(range.startContainer);
                var scope = (sectionId && sectionEl(sectionId)) || document.body;
                var before = document.createRange();
                before.selectNodeContents(scope);
                before.setEnd(range.startContainer, range.startOffset);
                var after = document.createRange();
                after.selectNodeContents(scope);
                after.setStart(range.endContainer, range.endOffset);
                anchor = {
                    quote: quote,
                    prefix: before.toString().replace(/\s+/g, ' ').slice(-32),
                    suffix: after.toString().replace(/\s+/g, ' ').slice(0, 32),
                    blockIndex: blockIndexOf(range.startContainer),
                    sectionId: sectionId || undefined,
                };
            }
        }
        var key = anchor ? anchor.quote + '|' + anchor.prefix : '';
        if (key !== lastSelection) { lastSelection = key; post({ __beeflowDocSelection: true, anchor: anchor }); }
    }

    // ── Text ranges (find and comment passages) ──────────────────────
    function textRanges(query, scope) {
        var out = [];
        if (!query) return out;
        var needle = query.toLowerCase();
        var walker = document.createTreeWalker(scope || document.body, NodeFilter.SHOW_TEXT);
        var nodes = [];
        var text = '';
        while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: text.length }); text += walker.currentNode.textContent; }
        var hay = text.toLowerCase();
        var at = hay.indexOf(needle);
        function locate(offset) {
            for (var i = nodes.length - 1; i >= 0; i--) if (nodes[i].start <= offset) return { node: nodes[i].node, offset: offset - nodes[i].start };
            return null;
        }
        while (at !== -1 && out.length < 500) {
            var a = locate(at);
            var b = locate(at + needle.length);
            if (a && b) { var r = document.createRange(); r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); out.push(r); }
            at = hay.indexOf(needle, at + Math.max(needle.length, 1));
        }
        return out;
    }
    function paint(name, ranges) {
        if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return false;
        if (ranges && ranges.length) CSS.highlights.set(name, new Highlight(...ranges));
        else CSS.highlights.delete(name);
        return true;
    }
    function reveal(range) {
        var el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    function find(query, step) {
        if (query !== findState.query) { findState = { query: query, ranges: textRanges(query), index: -1 }; }
        else findState.ranges = textRanges(query);
        var n = findState.ranges.length;
        if (n) findState.index = ((findState.index + (step || 1)) % n + n) % n;
        else findState.index = -1;
        paint('bf-find', findState.ranges);
        var current = findState.index >= 0 ? findState.ranges[findState.index] : null;
        if (!paint('bf-find-current', current ? [current] : []) && current) {
            var sel = document.getSelection();
            sel.removeAllRanges(); sel.addRange(current);
        }
        if (current) reveal(current);
        post({ __beeflowDocFound: true, count: n, index: findState.index });
    }

    // ── Other people, drawn outside the body ─────────────────────────
    function layer() {
        var el = document.getElementById('bf-peer-layer');
        if (!el) {
            el = document.createElement('div');
            el.id = 'bf-peer-layer';
            el.setAttribute('aria-hidden', 'true');
            document.documentElement.appendChild(el);
        }
        return el;
    }
    function drawPeers() {
        var host = layer();
        host.textContent = '';
        peers.forEach(function (p) {
            var target = p.sectionId && sectionEl(p.sectionId);
            if (!target) return;
            var rect = target.getBoundingClientRect();
            var colour = /^#[0-9a-fA-F]{6}$/.test(String(p.colour || '')) ? p.colour : TONES[Math.abs(Number(p.tone) || 0) % TONES.length];
            var box = document.createElement('div');
            box.className = 'bf-peer';
            box.style.cssText = 'top:' + (rect.top + window.scrollY - 3) + 'px;left:' + (rect.left + window.scrollX - 4) + 'px;width:' + (rect.width + 8) + 'px;height:' + (rect.height + 6) + 'px;border-color:' + colour;
            var label = document.createElement('span');
            label.style.background = colour;
            label.textContent = String(p.label || '').slice(0, 80);
            box.appendChild(label);
            host.appendChild(box);
        });
    }

    function caretInside(el) {
        var sel = document.getSelection();
        return !!(sel && sel.rangeCount && el.contains(sel.anchorNode));
    }
    function patch(sections) {
        var applied = [];
        var missing = [];
        Object.keys(sections || {}).forEach(function (id) {
            var el = sectionEl(id);
            // Never under somebody's caret: what they are typing there wins,
            // and the next save merges it again.
            if (!el || typeof sections[id] !== 'string' || (editing && caretInside(el))) { missing.push(id); return; }
            el.innerHTML = sections[id];
            protectTokens(el);
            applied.push(id);
        });
        reportLater();
        post({ __beeflowDocPatched: true, applied: applied, missing: missing });
    }

    function fit() {
        var scale = Math.min(1, Math.max(0.3, (window.innerWidth - 16) / (SHEET_PX + 2 * 16 * MM)));
        document.body.style.zoom = scale < 1 ? String(scale) : '';
    }

    function setEditing(on) {
        editing = !!on;
        document.body.setAttribute('contenteditable', editing ? 'true' : 'false');
        document.body.style.outline = 'none';
        if (editing) protectTokens();
    }

    function keyOf(e) {
        var mod = e.metaKey || e.ctrlKey;
        var k = String(e.key || '').toLowerCase();
        if (e.key === 'Escape') return 'escape';
        if (mod && e.shiftKey && k === 'h') return 'history';
        if (mod && e.altKey && k === 'm') return 'comment';
        if (mod && !e.shiftKey && !e.altKey && k === 's') return 'save';
        if (mod && !e.shiftKey && !e.altKey && k === 'f') return 'find';
        if (mod && k === '/') return 'help';
        return null;
    }

    window.addEventListener('message', function (e) {
        if (e.source !== parent) return;
        var d = e && e.data;
        if (!d || typeof d !== 'object') return;
        if (d.__beeflowDocFlush) { post({ __beeflowDocDirty: true, html: bodyContent(), requestId: d.requestId }); return; }
        if (d.__beeflowDocInsert && typeof d.key === 'string' && /^[A-Za-z0-9_.-]+$/.test(d.key)) {
            setEditing(true); document.body.focus();
            if (Array.isArray(d.fields) && d.fields.length <= 100 && d.fields.every(function (key) { return typeof key === 'string' && /^[A-Za-z0-9_.-]+$/.test(key); })) {
                var fields = d.fields.length ? d.fields : ['this'];
                var start = '<!--bf-template:' + window.btoa('{{#each ' + d.key + '}}') + '-->';
                var end = '<!--bf-template:' + window.btoa('{{/each}}') + '-->';
                document.execCommand('insertHTML', false, '<table><thead><tr>' + fields.map(function (key) { return '<th>' + key + '</th>'; }).join('') + '</tr></thead><tbody>' + start + '<tr>' + fields.map(function (key) { return '<td>{{' + key + '}}</td>'; }).join('') + '</tr>' + end + '</tbody></table>');
            } else document.execCommand('insertText', false, '{{' + d.key + '}}');
            protectTokens();
            post({ __beeflowDocDirty: true, html: bodyContent() });
            return;
        }
        if (d.__beeflowDocSection && typeof d.id === 'string') { var target = sectionEl(d.id); if (target) target.scrollIntoView({ behavior: 'smooth' }); return; }
        if (d.__beeflowDocScrollTo) { var node = outlineNodes()[Number(d.index) || 0]; if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
        if (d.__beeflowDocFind) { if (typeof d.query === 'string' && d.query) find(d.query.slice(0, 200), Number(d.step) || 1); else { paint('bf-find', []); paint('bf-find-current', []); findState = { query: '', ranges: [], index: -1 }; post({ __beeflowDocFound: true, count: 0, index: -1 }); } return; }
        if (d.__beeflowDocPeers) { peers = Array.isArray(d.peers) ? d.peers.slice(0, 20) : []; drawPeers(); return; }
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
    document.addEventListener('blur', function () { if (editing) post({ __beeflowDocDirty: true, html: bodyContent() }); }, true);
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
        if (!editing) return;
        e.preventDefault();
        var text = (e.clipboardData || window.clipboardData).getData('text/plain');
        try { document.execCommand('insertText', false, text); } catch (_) { /* engine without execCommand */ }
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
    return `<script>(${bridge.toString()})();</script>`;
}

module.exports = { buildEditBridgeScript };

'use strict';

const { bestEffort } = require('../utils/bestEffort');

/**
 * The first two parts of the edit bridge (see documentEditBridge.js): the
 * reporting half (outline, stats, caret, selection) and the drawing half
 * (find, peers, patch, theme). Each is serialised with toString() into the
 * preview's script, so each is self-contained browser code that only talks to
 * the others through the shared object B.
 */

/* global document, window, parent, NodeFilter, CSS, Highlight */

function bridgeCore(B) {
    var timers = {};
    var lastCaret;
    /** @type {string | null} */
    var lastSelection = null;
    var MM = 96 / 25.4;
    var PAGE_PX = 297 * MM;

    // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration -- runs in the editor's sandboxed srcdoc frame (opaque origin, frame-ancestors 'self'); the editor checks event.source
    function post(message) { try { parent.postMessage(message, '*'); } catch (err) { bestEffort('services/documentEditBridgeParts:post', err); /* parent gone */ } }
    /**
     * @param {string} name
     * @param {number | undefined} ms
     * @param {{ (): void; (): void; }} fn
     */
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
        copy.querySelectorAll('[data-doc-token]').forEach(function (/** @type {{ replaceWith: (arg0: Text) => void; textContent: string; }} */ el) { el.replaceWith(document.createTextNode(el.textContent)); });
        return copy.innerHTML.replace(/<!--bf-template:([A-Za-z0-9+/=]+)-->/g, function (_m, encoded) { return window.atob(encoded); });
    }

    /**
     * @param {Node} root
     */
    function protectTokens(root) {
        var walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
        /** @type {Node[]} */
        var nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(function (node) {
            if (!node.parentElement || node.parentElement.closest('[data-doc-token]')) return;
            var re = /\{\{[^{}]+\}\}/g;
            var text = node.textContent;
            /** @type {RegExpExecArray | null} */
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

    /**
     * @param {Node | null} node
     */
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
    function reportLater() { later('outline', 600, function () { reportOutline(); reportStats(); B.drawPeers(); }); }

    function reportCaret() {
        var sel = document.getSelection();
        var id = sel && sel.rangeCount ? sectionOf(sel.anchorNode) : null;
        if (id !== lastCaret) { lastCaret = id; post({ __beeflowDocCaret: true, sectionId: id }); }
    }

    /**
     * @param {Node} node
     */
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

    B.post = post;
    B.later = later;
    B.style = style;
    B.bodyContent = bodyContent;
    B.protectTokens = protectTokens;
    B.sectionOf = sectionOf;
    B.sectionEl = sectionEl;
    B.outlineNodes = outlineNodes;
    B.reportOutline = reportOutline;
    B.reportStats = reportStats;
    B.reportLater = reportLater;
    B.reportCaret = reportCaret;
    B.reportSelection = reportSelection;
}

function bridgeDraw(B) {
    var editing = false;
    var peers = [];
    var findState = { query: '', ranges: [], index: -1 };
    var MM = 96 / 25.4;
    var SHEET_PX = 210 * MM;
    var TONES = ['#0f766e', '#c2410c', '#15803d', '#1d4ed8', '#be123c', '#a16207'];
    var post = B.post;
    var protectTokens = B.protectTokens;
    var sectionEl = B.sectionEl;
    var reportLater = B.reportLater;

    // ── Text ranges (find and comment passages) ──────────────────────
    function textRanges(query, scope) {
        /** @type {Range[]} */
        var out = [];
        if (!query) return out;
        var needle = query.toLowerCase();
        var walker = document.createTreeWalker(scope || document.body, NodeFilter.SHOW_TEXT);
        /** @type {{ node: Node; start: number; }[]} */
        var nodes = [];
        var text = '';
        while (walker.nextNode()) { nodes.push({ node: walker.currentNode, start: text.length }); text += walker.currentNode.textContent; }
        var hay = text.toLowerCase();
        var at = hay.indexOf(needle);
        /**
         * @param {number} offset
         */
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
        /** @type {string[]} */
        var applied = [];
        /** @type {string[]} */
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

    function isEditing() { return editing; }
    function setPeers(list) { peers = list; }
    function resetFind() { findState = { query: '', ranges: [], index: -1 }; }

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

    B.textRanges = textRanges;
    B.paint = paint;
    B.reveal = reveal;
    B.find = find;
    B.drawPeers = drawPeers;
    B.patch = patch;
    B.fit = fit;
    B.setEditing = setEditing;
    B.keyOf = keyOf;
    B.isEditing = isEditing;
    B.setPeers = setPeers;
    B.resetFind = resetFind;
}

module.exports = { bridgeCore, bridgeDraw };

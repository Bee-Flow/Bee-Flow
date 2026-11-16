/**
 * The extra seal of a sealed frame (App Studio's react_block), applied by the runtime BEFORE the
 * component's code runs (entry.ts, `sealed: true`).
 *
 * The frame's policy (frameDoc.ts SEALED_FRAME_CSP) stops every request a document makes for
 * itself: fetch, XHR, WebSocket, EventSource, beacons, images, fonts, stylesheets, scripts and
 * frames. Measured in Chrome, some ways out are not covered by any policy:
 *
 *   - WebRTC: an RTCPeerConnection with a STUN/TURN server sends UDP to any host it names;
 *   - a nested frame: a `srcdoc` iframe inherits the policy and the sandbox, but has a window
 *     of its own, and so its own RTCPeerConnection;
 *   - `<link rel="prerender">`: the browser fetches it whatever the policy says;
 *   - `<meta http-equiv="refresh">`: navigates the frame itself (the embedding page's frame-src
 *     stops that in the product, a page without one does not).
 *
 * So, in this window, before any code of the component runs:
 *   - the peer connection constructors are gone for good (non-configurable);
 *   - an element that opens a window or asks for an address outside the policy (iframe, frame,
 *     object, embed, portal, fencedframe, link, meta) never reaches the document: every DOM
 *     method that inserts nodes or markup takes them out first (markup is read in an inert
 *     <template>), and a MutationObserver removes whatever arrives another way;
 *   - shadow roots (the observer cannot see into them), setHTMLUnsafe, document.write and
 *     execCommand are refused.
 * A component has no use for any of these. This narrows what code in the frame can do; the
 * frame's policy and sandbox remain the boundary.
 */

type Win = Window & typeof globalThis;

const GONE = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'RTCIceTransport'];
const BLOCKED = ['iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'fencedframe', 'link', 'meta'];
const BLOCKED_SET = new Set(BLOCKED);
const BLOCKED_SELECTOR = BLOCKED.join(',');

/** A property may be (re)defined only while it is configurable; one that is not stays as it is. */
function definable(target: object, name: string): boolean {
    const own = Object.getOwnPropertyDescriptor(target, name);
    return !own || own.configurable === true;
}

function lock(target: object, name: string, value: unknown): void {
    if (definable(target, name)) Object.defineProperty(target, name, { value, writable: false, configurable: false, enumerable: false });
}

function lockSetter(target: object, name: string, set: (this: Element, value: string) => void, get: (this: Element) => string): void {
    if (definable(target, name)) Object.defineProperty(target, name, { get, set, configurable: false, enumerable: true });
}

function refuse(what: string): () => never {
    return () => { throw new Error(`${what} is not available in a sealed React block.`); };
}

const isElement = (node: unknown): node is Element => !!node && (node as Node).nodeType === 1;
const isBlocked = (node: unknown): boolean => isElement(node) && BLOCKED_SET.has(node.localName);

/** Take every blocked element out of `node` (its descendants; the node itself is the caller's). */
function scrub(node: unknown): void {
    const n = node as (Node & ParentNode) | null;
    if (!n || typeof n.querySelectorAll !== 'function' || !n.firstChild) return;
    for (const inner of Array.from(n.querySelectorAll(BLOCKED_SELECTOR))) inner.remove();
}

/** `node`, scrubbed, or null when it is itself blocked (it is then not inserted). */
function clean<T>(node: T): T | null {
    if (isBlocked(node)) return null;
    scrub(node);
    return node;
}

/** Wrap a method so its node arguments are cleaned first; blocked nodes are dropped (strings are text). */
function wrapNodes(proto: object | undefined, name: string): void {
    const original = proto ? (proto as Record<string, unknown>)[name] : undefined;
    if (!proto || typeof original !== 'function') return;
    lock(proto, name, function (this: unknown, ...args: unknown[]) {
        const kept = args.map((a) => (typeof a === 'string' ? a : clean(a))).filter((a) => a !== null);
        return (original as (...a: unknown[]) => unknown).apply(this, kept);
    });
}

/** Wrap a method whose FIRST argument is the node to insert (appendChild, insertBefore, replaceChild…). */
function wrapFirstNode(proto: object | undefined, name: string): void {
    const original = proto ? (proto as Record<string, unknown>)[name] : undefined;
    if (!proto || typeof original !== 'function') return;
    lock(proto, name, function (this: unknown, node: unknown, ...rest: unknown[]) {
        if (clean(node) === null) return node;
        return (original as (...a: unknown[]) => unknown).call(this, node, ...rest);
    });
}

/** Markup read where nothing loads or runs (a template's content), with the blocked elements taken out. */
function inertFragment(win: Win, html: string, setInner: (this: Element, v: string) => void): DocumentFragment {
    const template = win.document.createElement('template');
    setInner.call(template, String(html));
    scrub(template.content);
    return template.content;
}

function sealMarkup(win: Win): void {
    const ElementProto = win.Element.prototype;
    const inner = Object.getOwnPropertyDescriptor(ElementProto, 'innerHTML');
    const outer = Object.getOwnPropertyDescriptor(ElementProto, 'outerHTML');
    const adjacentHtml = ElementProto.insertAdjacentHTML;
    const replaceChildren = ElementProto.replaceChildren;
    const replaceWith = ElementProto.replaceWith;
    const adjacentElement = ElementProto.insertAdjacentElement;
    if (!inner?.set || !inner.get || !outer?.set || !outer.get) return;
    const setInner = inner.set;
    const getInner = inner.get;
    lockSetter(ElementProto, 'innerHTML', function (this: Element, value: string) {
        // A template's own markup is inert; what is later taken out of it is cleaned on insert.
        if (this.localName === 'template') { setInner.call(this, value); return; }
        replaceChildren.call(this, inertFragment(win, value, setInner));
    }, getInner as (this: Element) => string);
    lockSetter(ElementProto, 'outerHTML', function (this: Element, value: string) {
        replaceWith.call(this, inertFragment(win, value, setInner));
    }, outer.get as (this: Element) => string);
    lock(ElementProto, 'insertAdjacentHTML', function (this: Element, where: InsertPosition, html: string) {
        const fragment = inertFragment(win, html, setInner);
        const at = String(where).toLowerCase();
        if (at === 'beforebegin' || at === 'afterend') {
            if (!this.parentNode) return adjacentHtml.call(this, where, '');
            this.parentNode.insertBefore(fragment, at === 'beforebegin' ? this : this.nextSibling);
            return undefined;
        }
        if (at === 'afterbegin') this.insertBefore(fragment, this.firstChild);
        else if (at === 'beforeend') this.appendChild(fragment);
        else adjacentHtml.call(this, where, '');
        return undefined;
    });
    lock(ElementProto, 'insertAdjacentElement', function (this: Element, where: InsertPosition, el: Element) {
        return clean(el) === null ? null : adjacentElement.call(this, where, el);
    });
}

function observe(win: Win): void {
    if (typeof win.MutationObserver !== 'function') return;
    const observer = new win.MutationObserver((records) => {
        for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
                if (isBlocked(node)) (node as Element).remove();
                else scrub(node);
            }
        }
    });
    observer.observe(win.document, { childList: true, subtree: true });
}

export function sealWindow(win: Win): void {
    for (const name of GONE) lock(win, name, undefined);
    const nodeProto = win.Node.prototype;
    for (const name of ['appendChild', 'insertBefore', 'replaceChild']) wrapFirstNode(nodeProto, name);
    for (const proto of [win.Element.prototype, win.Document.prototype, win.DocumentFragment.prototype]) {
        for (const name of ['append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren']) wrapNodes(proto, name);
    }
    if (win.CharacterData) for (const name of ['before', 'after', 'replaceWith']) wrapNodes(win.CharacterData.prototype, name);
    if (win.Range) wrapFirstNode(win.Range.prototype, 'insertNode');
    sealMarkup(win);
    lock(win.Element.prototype, 'attachShadow', refuse('attachShadow'));
    lock(win.Element.prototype, 'setHTMLUnsafe', refuse('setHTMLUnsafe'));
    lock(win.Document.prototype, 'write', refuse('document.write'));
    lock(win.Document.prototype, 'writeln', refuse('document.writeln'));
    lock(win.Document.prototype, 'execCommand', refuse('execCommand'));
    observe(win);
    // The document's own <meta> elements have done their work (a policy in a meta element stays
    // in force once read); taken out, none of them can be turned into a refresh.
    for (const meta of Array.from(win.document.querySelectorAll('meta'))) meta.remove();
}

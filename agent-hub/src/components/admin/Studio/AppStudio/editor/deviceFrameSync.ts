/**
 * Keeps a same-origin iframe's document looking like the host document: every
 * stylesheet the host has (copied, in order, and kept up to date as bundles
 * add or replace theirs) and the attributes on <html> and <body> that carry
 * the theme (data-theme, dark mode, the accent and font variables).
 *
 * The App Studio device preview renders the app tree into such a frame, so
 * the app's @media rules evaluate against the frame's width. Copying "every
 * stylesheet present" rather than naming files keeps it right whatever the
 * bundler splits the CSS into.
 */

/** Marks the copies, so a sync never touches what the frame has of its own. */
const CLONE_ATTR = 'data-device-frame-style';

/** <body> attributes left alone: a dialog's scroll lock writes the host body's style. */
const BODY_SKIP = new Set(['style']);

function hostStyleNodes(src: Document): Element[] {
    return Array.from(src.head.querySelectorAll('style, link[rel~="stylesheet"]'));
}

function isStyle(node: Element): node is HTMLStyleElement {
    return node.tagName === 'STYLE';
}

/** The CSS text of a <style>, including rules added through CSSOM (insertRule leaves no text). */
function styleText(node: HTMLStyleElement): string {
    if (node.textContent) return node.textContent;
    try {
        return Array.from(node.sheet?.cssRules ?? [], (rule) => rule.cssText).join('\n');
    } catch {
        return '';
    }
}

function cloneStyleNode(node: Element, dst: Document): Element {
    const copy = dst.importNode(node, true);
    if (isStyle(node)) copy.textContent = styleText(node);
    copy.setAttribute(CLONE_ATTR, '');
    return copy;
}

function refreshClone(source: Element, clone: Element): void {
    if (isStyle(source)) {
        const text = styleText(source);
        if (clone.textContent !== text) clone.textContent = text;
        return;
    }
    for (const name of ['href', 'media']) {
        const value = source.getAttribute(name);
        if (value === clone.getAttribute(name)) continue;
        if (value == null) clone.removeAttribute(name);
        else clone.setAttribute(name, value);
    }
}

/**
 * Brings the frame's copies in line with the host's stylesheets. Copies that
 * already exist stay where they are (moving a <link> reloads it, which would
 * flash the frame unstyled); a new one goes in before the copy of the sheet
 * that follows it, so the cascade order matches the host's.
 */
function syncStyles(src: Document, dst: Document, clones: Map<Element, Element>): void {
    const wanted = hostStyleNodes(src);
    const present = new Set(wanted);
    for (const [source, clone] of clones) {
        if (present.has(source)) continue;
        clone.remove();
        clones.delete(source);
    }
    let next: Element | null = null;
    for (let i = wanted.length - 1; i >= 0; i -= 1) {
        const source = wanted[i];
        let clone = clones.get(source);
        if (clone) {
            refreshClone(source, clone);
        } else {
            clone = cloneStyleNode(source, dst);
            clones.set(source, clone);
            dst.head.insertBefore(clone, next);
        }
        next = clone;
    }
}

/** Makes `to` carry exactly the attributes of `from`, except the skipped names. */
function mirrorAttributes(from: Element, to: Element, skip: ReadonlySet<string> = new Set()): void {
    for (const { name } of Array.from(to.attributes)) {
        if (!skip.has(name) && !from.hasAttribute(name)) to.removeAttribute(name);
    }
    for (const { name, value } of Array.from(from.attributes)) {
        if (!skip.has(name) && to.getAttribute(name) !== value) to.setAttribute(name, value);
    }
}

/**
 * Copies the host's stylesheets and root attributes into `dst` now and on
 * every change after. Returns the function that stops it and removes the
 * copies.
 */
export function startFrameSync(src: Document, dst: Document): () => void {
    const clones = new Map<Element, Element>();
    const sync = () => {
        syncStyles(src, dst, clones);
        mirrorAttributes(src.documentElement, dst.documentElement);
        mirrorAttributes(src.body, dst.body, BODY_SKIP);
    };
    sync();
    const view = src.defaultView;
    if (!view || typeof view.MutationObserver !== 'function') {
        return () => { clones.forEach((clone) => clone.remove()); };
    }
    const observer = new view.MutationObserver(sync);
    observer.observe(src.head, { childList: true, subtree: true, characterData: true, attributes: true });
    observer.observe(src.documentElement, { attributes: true });
    observer.observe(src.body, { attributes: true });
    return () => {
        observer.disconnect();
        clones.forEach((clone) => clone.remove());
        clones.clear();
    };
}

/**
 * Collapse the quoted history of a reply, the way Gmail and Outlook do.
 *
 * Works on the DOM of the already sanitized e-mail document inside the iframe
 * (the parent reaches it through allow-same-origin; nothing here runs inside the
 * mail). The quote start is found by the markers the big clients write; the
 * element and everything after it in document order is hidden, and a toggle
 * button takes its place.
 */

const QUOTE_SELECTORS = [
    '.gmail_quote_container',
    '.gmail_quote',
    'blockquote[type="cite"]',
    '#appendonsend',
    '#divRplyFwdMsg',
    '#mail-editor-reference-message-container',
    '.moz-cite-prefix',
    '.yahoo_quoted',
].join(',');

/** Outlook desktop: the rule above the "Van:/Verzonden:" block. */
const OUTLOOK_RULE = /border-top:\s*solid\s*#(E1E1E1|B5C4DF)/i;

const HIDDEN_ATTR = 'data-bf-quote-hidden';
const TOGGLE_ATTR = 'data-bf-quote-toggle';

export interface QuoteLabels { show: string; hide: string }

export interface QuoteController {
    /** Flip between collapsed and expanded. */
    toggle: () => void;
    isExpanded: () => boolean;
}

/** The first quote marker in document order, or null. */
export function findQuoteStart(doc: Document): Element | null {
    const body = doc.body;
    if (!body) return null;
    let best: Element | null = body.querySelector(QUOTE_SELECTORS);
    for (const el of Array.from(body.querySelectorAll('[style]'))) {
        if (!OUTLOOK_RULE.test(el.getAttribute('style') || '')) continue;
        if (!best || (best.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) best = el;
        break; // querySelectorAll is in document order: the first hit is the earliest
    }
    return best;
}

const NON_CONTENT = new Set(['STYLE', 'SCRIPT', 'TITLE', 'HEAD']);

/** Is there text (or a picture) before the marker? A bare forward has none. */
function hasVisibleContentBefore(doc: Document, marker: Element): boolean {
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n === marker || marker.contains(n)) return false;
        // Reaching a node that FOLLOWS the marker would have returned above.
        if (n.nodeType === Node.ELEMENT_NODE) {
            if ((n as Element).tagName === 'IMG' && !(n as Element).contains(marker)) return true;
            continue;
        }
        const parent = n.parentElement;
        if (parent && NON_CONTENT.has(parent.tagName)) continue;
        if ((n.textContent || '').replace(/[\s ​]+/g, '') !== '') return true;
    }
    return false;
}

/** The nodes from the marker to the end of the body, in document order (top-level of each level). */
function nodesFrom(doc: Document, marker: Element): Element[] {
    const out: Element[] = [marker];
    let level: Node = marker;
    while (level && level !== doc.body) {
        for (let sib = level.nextSibling; sib; sib = sib.nextSibling) {
            if (sib.nodeType === Node.ELEMENT_NODE) {
                out.push(sib as Element);
            } else if (sib.nodeType === Node.TEXT_NODE && (sib.textContent || '').trim() !== '') {
                // A text node cannot carry a style: wrap it so it can be hidden.
                const span = doc.createElement('span');
                sib.parentNode?.replaceChild(span, sib);
                span.appendChild(sib);
                out.push(span);
                sib = span;
            }
        }
        level = level.parentNode as Node;
    }
    return out;
}

function hide(el: HTMLElement): void {
    el.setAttribute(HIDDEN_ATTR, `${el.style.getPropertyValue('display')}|${el.style.getPropertyPriority('display')}`);
    el.style.setProperty('display', 'none', 'important');
}

function restore(el: HTMLElement): void {
    const saved = el.getAttribute(HIDDEN_ATTR);
    if (saved == null) return;
    const sep = saved.lastIndexOf('|');
    const value = saved.slice(0, sep);
    const priority = saved.slice(sep + 1);
    if (value) el.style.setProperty('display', value, priority);
    else el.style.removeProperty('display');
    el.removeAttribute(HIDDEN_ATTR);
}

function makeToggle(doc: Document): HTMLButtonElement {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.setAttribute(TOGGLE_ATTR, 'true');
    btn.setAttribute('style', 'display:block;margin:8px 0;padding:0 8px;border:1px solid #d0d5dd;border-radius:10px;'
        + 'background:#f2f4f7;color:#475467;font:inherit;font-size:12px;line-height:16px;cursor:pointer');
    return btn;
}

/**
 * Hide the quoted history and put a toggle button at its place. Returns a
 * controller, or null when there is nothing to collapse (no marker, or no
 * visible text before it).
 */
export function collapseQuotedHistory(doc: Document, labels: QuoteLabels): QuoteController | null {
    const marker = findQuoteStart(doc);
    if (!marker || !marker.parentNode) return null;
    if (!hasVisibleContentBefore(doc, marker)) return null;

    const nodes = nodesFrom(doc, marker) as HTMLElement[];
    const button = makeToggle(doc);
    marker.parentNode.insertBefore(button, marker);

    let expanded = false;
    const apply = () => {
        for (const el of nodes) {
            if (expanded) restore(el);
            else if (!el.hasAttribute(HIDDEN_ATTR)) hide(el);
        }
        button.textContent = expanded ? `··· ${labels.hide}` : `··· ${labels.show}`;
        button.setAttribute('aria-expanded', String(expanded));
    };
    apply();
    return {
        toggle: () => { expanded = !expanded; apply(); },
        isExpanded: () => expanded,
    };
}

/** Is this click target the collapse toggle (or inside it)? */
export function isQuoteToggle(target: EventTarget | null): boolean {
    return !!(target as Element | null)?.closest?.(`[${TOGGLE_ATTR}]`);
}

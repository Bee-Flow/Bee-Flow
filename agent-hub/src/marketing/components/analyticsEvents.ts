import { logger } from '../../utils/logger';
/**
 * Automatic interaction tracking for published CMS sites.
 *
 * Without custom events a Umami site only knows pageviews, which makes goals,
 * funnels and journeys empty by construction. This adds the four interactions
 * every marketing site cares about, with zero per-site configuration:
 *
 *   cta_click     — a button-styled control (the site's Button) or a link inside a block
 *   outbound_click— a link to another host
 *   file_download — a link to a document-ish file
 *   form_start    — the first focus in a form, once per form per page view
 *   form_submit   — a form submission attempt
 *   form_success  — a submission the server accepted (sent by the form itself)
 *
 * Consent: this deliberately does NOT read consent itself. It calls
 * `window.umami.track`, which only exists once the tracker script has loaded —
 * and the tracker is already gated on consent, per-page opt-out and the preview
 * bail. One gate, not two that can drift apart.
 *
 * Privacy rules (hard):
 *   - hrefs are stripped of query string and hash before being sent
 *   - input values are never read
 *   - labels are truncated, and come from visible text only
 *   - event NAMES are a fixed set, never derived from page content, so
 *     cardinality stays bounded
 *   - `umami.identify()` is never called
 */

declare global {
    interface Window {
        umami?: { track?: (name: string, data?: Record<string, unknown>) => void };
    }
}

const MAX_LABEL = 80;
const MAX_PATH = 300;

// Extensions we count as a download. Deliberately short — anything else is
// just an outbound or internal link.
const DOWNLOAD_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|tar|gz|dmg|pkg|exe|mp3|mp4|wav|mov)$/i;

function track(name: string, data: Record<string, unknown>) {
    try {
        const fn = typeof window !== 'undefined' && window.umami && window.umami.track;
        if (typeof fn !== 'function') return;   // tracker absent → no consent → no-op
        window.umami?.track?.(name, data);
    } catch (err) { logger.debug('analytics must never break the page', err); }
}

function clean(str: string | null, max: number = MAX_LABEL) {
    if (!str) return '';
    return String(str).replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Path only — query strings and fragments routinely carry personal data. */
export function safeHref(href: string | URL) {
    if (!href) return '';
    try {
        const u = new URL(href, window.location.href);
        return `${u.origin}${u.pathname}`.slice(0, MAX_PATH);
    } catch {
        return String(href).split(/[?#]/)[0].slice(0, MAX_PATH);
    }
}

function isSameHost(href: string | URL) {
    try {
        return new URL(href, window.location.href).host === window.location.host;
    } catch {
        return true;
    }
}

/** Visible label for an element, falling back through the usual a11y sources. */
function labelFor(el: Element) {
    return clean(
        el.getAttribute?.('aria-label')
        || el.textContent
        || el.getAttribute?.('title')
        || el.getAttribute?.('alt')
        || '',
    );
}

/**
 * Which CMS block an element sits in. The renderer stamps `data-cms-block-id`
 * (already used by the admin preview's click-to-select) plus
 * `data-cms-block-type` on every block wrapper — that attribution is what makes
 * these events useful in funnels.
 */
function blockOf(el: Element): { block?: string; blockType?: string } {
    const holder = el.closest?.('[data-cms-block-id]');
    if (!holder) return {};
    const out: { block?: string; blockType?: string } = {};
    const id = holder.getAttribute('data-cms-block-id');
    const type = holder.getAttribute('data-cms-block-type');
    if (id) out.block = clean(id, 40);
    if (type) out.blockType = clean(type, 40);
    return out;
}

/**
 * Download / outbound handling for a real navigable href.
 * Returns true when it emitted an event and the click needs nothing further.
 */
function trackLink(href: string | null, label: string, block: { block?: string; blockType?: string }) {
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false;
    const safe = safeHref(href);

    if (DOWNLOAD_EXT.test(safe)) {
        const ext = (safe.match(DOWNLOAD_EXT)?.[1] || '').toLowerCase();
        track('file_download', { href: safe, ext, label, ...block });
        return true;
    }
    if (!isSameHost(href)) {
        let host = '';
        try { host = new URL(href, window.location.href).host; } catch (err) { logger.debug('ignore', err); }
        track('outbound_click', { href: safe, host, label, ...block });
        return true;
    }
    return false;
}

/**
 * A call to action is a control styled as the site's Button (header and hero
 * CTAs, CTA blocks) or a link inside a block. Tabs, accordions, carousel
 * arrows, the cookie banner and the language switcher are page controls: they
 * used to count too, which put cta_click above the number of visits.
 */
function isCta(el: Element, block: { block?: string }) {
    if (el.classList?.contains('btn')) return true;
    return el.tagName === 'A' && !!block.block;
}

function onClick(e: MouseEvent) {
    const el = (e.target as Element | null)?.closest?.('a[href], button, [role="button"]');
    if (!el) return;

    const href = el.tagName === 'A' ? el.getAttribute('href') : null;
    const label = labelFor(el);
    const block = blockOf(el);

    if (trackLink(href, label, block)) return;

    // A bare internal link outside a block is ordinary navigation and is
    // already captured as a pageview, so it is not worth an event.
    if (!label || !isCta(el, block)) return;
    track('cta_click', { label, href: href ? safeHref(href) : undefined, ...block });
}

/** Identify a form, never its contents. */
function formName(form: Element) {
    return clean(form.getAttribute('name') || form.getAttribute('id') || form.getAttribute('aria-label') || 'form', 40);
}

function onSubmit(e: Event) {
    const form = e.target as HTMLFormElement | null;
    if (!form || form.tagName !== 'FORM') return;
    track('form_submit', { form: formName(form), ...blockOf(form) });
}

// Forms already counted as started in this page view.
let startedForms = new WeakSet<Element>();

function onFocusIn(e: FocusEvent) {
    const field = (e.target as Element | null)?.closest?.('input, select, textarea');
    const form = field?.closest('form');
    // The honeypot is out of the tab order; a focus there is not a person starting.
    if (!field || !form || field.getAttribute('tabindex') === '-1' || startedForms.has(form)) return;
    startedForms.add(form);
    track('form_start', { form: formName(form), ...blockOf(form) });
}

/**
 * A website form the server accepted. Only the form knows that answer, so it
 * calls this itself; the name matches the form_submit / form_start label.
 */
export function trackFormSuccess(form: string, block: string | null) {
    track('form_success', { form: clean(form || 'form', 40), ...(block ? { block: clean(block, 40), blockType: 'form' } : {}) });
}

/**
 * Attach the delegated listeners. Returns a cleanup function.
 * Capture phase so a handler calling stopPropagation doesn't hide the event.
 */
export function startAnalyticsEvents() {
    if (typeof document === 'undefined') return () => {};
    startedForms = new WeakSet<Element>();
    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('submit', onSubmit, true);
        document.removeEventListener('focusin', onFocusIn, true);
    };
}

// Exported for tests.
const _internal = { onClick, onSubmit, labelFor, DOWNLOAD_EXT };

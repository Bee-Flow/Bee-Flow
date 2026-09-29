/**
 * Static HTML accessibility lint — the cheap half of the EAA Art. 4 check.
 *
 * Pure function over a string of HTML (cheerio, no DOM emulation, no
 * network) so it can run inside a compliance sweep over hundreds of published
 * pages and inside a unit test with fixture strings. It covers what a parse
 * tree can prove: language declared, image alternatives, labelled controls,
 * named links/buttons, page title, iframe titles, heading structure, ids,
 * focus order hints, refresh/zoom/autoplay meta and table headers.
 *
 * It deliberately does NOT cover colour contrast, focus visibility, keyboard
 * operability, reflow, dynamic ARIA state or motion — those need a rendered
 * DOM plus axe, which is what the CI conformance artefact
 * (conformance.schema.json) is for. The check's description says so.
 *
 *   lint(html, { lang }) → {
 *     errors:   [{ rule, wcag, count, samples: [snippet…] }],  // ≤ 10 samples each
 *     warnings: [{ rule, wcag, count, samples }],
 *     rules_checked: ['html-lang', …],
 *     rules_skipped: [{ rule, reason }],   // e.g. document-level rules on a fragment
 *     fragment: boolean,                   // input had no <html> element
 *     lang: string|null,                   // declared <html lang>, or opts.lang for fragments
 *     version: '1.0.0',
 *   }
 *
 * Fragments: a page stored as body-only HTML (the AI-webpage `html` slot is
 * served inside the public viewer's own document) has no say over `<html
 * lang>` or `<title>`, so those two rules are skipped — not passed — and
 * reported under rules_skipped. `opts.lang` is then the language the shell
 * declares, recorded for the evidence row.
 *
 * Samples are element snippets from the PAGE (public content). E-mail
 * addresses are still scrubbed before they reach the evidence chain: a
 * `mailto:` link or a footer address must not end up in compliance evidence.
 */

const cheerio = require('cheerio');

const VERSION = '1.0.0';
const MAX_SAMPLES = 10;
const SNIPPET_MAX = 160;

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Whole-name match after whitespace/punctuation normalisation — a substring
// match on "hier" would flag "hiërarchie" and "Bekijk hier de voorwaarden".
const GENERIC_LINK_RE = /^(?:click here|klik hier|read more|lees meer|meer lezen|lees verder|learn more|hier|here|more|meer|link|details)$/i;

const RULES = {
    'html-lang':         { wcag: '3.1.1', level: 'error',   documentOnly: true },
    'img-alt':           { wcag: '1.1.1', level: 'error' },
    'svg-alt':           { wcag: '1.1.1', level: 'warning' },
    'control-label':     { wcag: '1.3.1/3.3.2', level: 'error' },
    'link-name':         { wcag: '2.4.4', level: 'error' },
    'link-text-generic': { wcag: '2.4.4', level: 'warning' },
    'button-name':       { wcag: '4.1.2', level: 'error' },
    'page-title':        { wcag: '2.4.2', level: 'error',   documentOnly: true },
    'iframe-title':      { wcag: '4.1.2', level: 'error' },
    'heading-order':     { wcag: '1.3.1', level: 'warning' },
    'duplicate-id':      { wcag: '4.1.1', level: 'warning' },
    'tabindex-positive': { wcag: '2.4.3', level: 'warning' },
    'meta-refresh':      { wcag: '2.2.1', level: 'warning' },
    'viewport-zoom':     { wcag: '1.4.4', level: 'warning' },
    'media-autoplay':    { wcag: '1.4.2', level: 'warning' },
    'table-headers':     { wcag: '1.3.1', level: 'warning' },
};

const SKIPPED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'image', 'reset']);

function _norm(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

function _scrub(s) {
    return String(s || '').replace(EMAIL_RE, '[email]');
}

function _attr($el, name) {
    const v = $el.attr(name);
    return v === undefined || v === null ? null : String(v);
}

function _hidden($el) {
    return _norm(_attr($el, 'aria-hidden')).toLowerCase() === 'true';
}

function _presentational($el) {
    const role = _norm(_attr($el, 'role')).toLowerCase();
    return role === 'presentation' || role === 'none';
}

/**
 * Text referenced by aria-labelledby: the concatenated text of every id the
 * attribute names. `byId` is built once per document (ids may contain
 * characters a CSS selector would choke on).
 */
function _labelledbyText($, $el, byId) {
    const ref = _norm(_attr($el, 'aria-labelledby'));
    if (!ref) return '';
    return ref.split(/\s+/).map(id => byId.get(id) || '').join(' ').trim();
}

/** Accessible-name approximation for links and buttons. */
function _accessibleName($, el, byId) {
    const $el = $(el);
    const ariaLabel = _norm(_attr($el, 'aria-label'));
    if (ariaLabel) return ariaLabel;
    const labelled = _labelledbyText($, $el, byId);
    if (labelled) return labelled;
    const text = _norm($el.text());
    if (text) return text;
    const imgAlts = $el.find('img[alt]').map((_, img) => _norm($(img).attr('alt'))).get().filter(Boolean);
    if (imgAlts.length) return imgAlts.join(' ');
    const svgTitle = _norm($el.find('svg > title').first().text());
    if (svgTitle) return svgTitle;
    const svgLabel = $el.find('svg[aria-label]').map((_, s) => _norm($(s).attr('aria-label'))).get().filter(Boolean);
    if (svgLabel.length) return svgLabel.join(' ');
    const title = _norm(_attr($el, 'title'));
    if (title) return title;
    return '';
}

function _controlHasLabel($, el, byId) {
    const $el = $(el);
    if (_norm(_attr($el, 'aria-label'))) return true;
    if (_labelledbyText($, $el, byId)) return true;
    if (_norm(_attr($el, 'title'))) return true;
    const id = _attr($el, 'id');
    if (id) {
        const explicit = $('label').filter((_, l) => _attr($(l), 'for') === id).first();
        if (explicit.length && _norm(explicit.text())) return true;
    }
    const wrapping = $el.closest('label');
    if (wrapping.length && _norm(wrapping.text())) return true;
    return false;
}

class Collector {
    constructor($) {
        this.$ = $;
        this.findings = new Map(); // rule → { count, samples[] }
    }
    add(rule, el, note) {
        let f = this.findings.get(rule);
        if (!f) { f = { count: 0, samples: [] }; this.findings.set(rule, f); }
        f.count += 1;
        if (f.samples.length < MAX_SAMPLES) {
            const snippet = el ? this.snippet(el) : '';
            f.samples.push(_scrub(note ? (snippet ? `${note}: ${snippet}` : note) : snippet));
        }
    }
    snippet(el) {
        let html = '';
        try { html = this.$.html(el); } catch { html = ''; }
        html = _norm(html);
        return html.length > SNIPPET_MAX ? `${html.slice(0, SNIPPET_MAX - 1)}…` : html;
    }
}

/**
 * @param {string} html
 * @param {{ lang?: string }} [opts]
 */
function lint(html, opts = {}) {
    const src = typeof html === 'string' ? html : '';
    const fragment = !/<html[\s>]/i.test(src);
    const $ = cheerio.load(src);
    const c = new Collector($);
    const rulesChecked = [];
    const rulesSkipped = [];

    // id → text map, for aria-labelledby resolution and duplicate detection.
    const byId = new Map();
    const idCounts = new Map();
    $('[id]').each((_, el) => {
        const id = _attr($(el), 'id');
        if (!id) return;
        idCounts.set(id, (idCounts.get(id) || 0) + 1);
        if (!byId.has(id)) byId.set(id, _norm($(el).text()) || _norm(_attr($(el), 'aria-label')) || _norm(_attr($(el), 'alt')));
    });

    let declaredLang = null;

    // ── html-lang ──
    if (fragment) {
        rulesSkipped.push({ rule: 'html-lang', reason: 'fragment: the document shell declares the language' });
        declaredLang = opts.lang && LANG_RE.test(String(opts.lang)) ? String(opts.lang) : null;
    } else {
        rulesChecked.push('html-lang');
        const lang = _norm($('html').attr('lang'));
        if (lang && LANG_RE.test(lang)) declaredLang = lang;
        else c.add('html-lang', null, lang ? `invalid lang="${lang}"` : 'no lang attribute on <html>');
    }

    // ── page-title ──
    if (fragment) {
        rulesSkipped.push({ rule: 'page-title', reason: 'fragment: the document shell supplies the title' });
    } else {
        rulesChecked.push('page-title');
        const title = _norm($('title').first().text());
        if (!title) c.add('page-title', null, 'no <title> or empty <title>');
    }

    // ── img-alt / svg-alt ──
    rulesChecked.push('img-alt', 'svg-alt');
    $('img').each((_, el) => {
        const $el = $(el);
        if (_attr($el, 'alt') !== null) return;           // alt="" is a valid decorative marker
        if (_presentational($el) || _hidden($el)) return;
        if (_norm(_attr($el, 'aria-label')) || _labelledbyText($, $el, byId)) return;
        c.add('img-alt', el);
    });
    $('svg').each((_, el) => {
        const $el = $(el);
        if (_presentational($el) || _hidden($el)) return;
        if (_norm(_attr($el, 'aria-label')) || _labelledbyText($, $el, byId)) return;
        if (_norm($el.children('title').first().text())) return;
        // Inside a link/button that already has a name the svg is decorative.
        if ($el.closest('a, button, [role="button"]').length && _accessibleName($, $el.closest('a, button, [role="button"]')[0], byId)) return;
        c.add('svg-alt', el);
    });

    // ── control-label ──
    rulesChecked.push('control-label');
    $('input, select, textarea').each((_, el) => {
        const $el = $(el);
        if (_hidden($el)) return;
        if (el.tagName && el.tagName.toLowerCase() === 'input') {
            const type = _norm(_attr($el, 'type')).toLowerCase() || 'text';
            if (SKIPPED_INPUT_TYPES.has(type)) return;
        }
        if (!_controlHasLabel($, el, byId)) c.add('control-label', el);
    });

    // ── link-name / link-text-generic ──
    rulesChecked.push('link-name', 'link-text-generic');
    $('a[href]').each((_, el) => {
        const $el = $(el);
        if (_hidden($el)) return;
        const name = _accessibleName($, el, byId);
        if (!name) { c.add('link-name', el); return; }
        const bare = name.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
        if (GENERIC_LINK_RE.test(bare)) c.add('link-text-generic', el);
    });

    // ── button-name ──
    rulesChecked.push('button-name');
    $('button, [role="button"]').each((_, el) => {
        const $el = $(el);
        if (_hidden($el)) return;
        if (!_accessibleName($, el, byId)) c.add('button-name', el);
    });
    $('input').each((_, el) => {
        const $el = $(el);
        if (_hidden($el)) return;
        const type = _norm(_attr($el, 'type')).toLowerCase();
        if (!['button', 'image'].includes(type)) return; // submit/reset carry a UA default label
        const name = _norm(_attr($el, 'value')) || _norm(_attr($el, 'aria-label')) || _labelledbyText($, $el, byId)
            || _norm(_attr($el, 'title')) || (type === 'image' ? _norm(_attr($el, 'alt')) : '');
        if (!name) c.add('button-name', el);
    });

    // ── iframe-title ──
    rulesChecked.push('iframe-title');
    $('iframe').each((_, el) => {
        const $el = $(el);
        if (_hidden($el)) return;
        if (_norm(_attr($el, 'title')) || _norm(_attr($el, 'aria-label')) || _labelledbyText($, $el, byId)) return;
        c.add('iframe-title', el);
    });

    // ── heading-order ──
    rulesChecked.push('heading-order');
    let prevLevel = 0;
    let h1Count = 0;
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
        const level = Number(String(el.tagName).slice(1));
        if (level === 1) h1Count += 1;
        if (prevLevel > 0 && level > prevLevel + 1) c.add('heading-order', el, `h${prevLevel} → h${level}`);
        prevLevel = level;
    });
    if (h1Count > 1) c.add('heading-order', null, `${h1Count} <h1> elements`);

    // ── duplicate-id ──
    rulesChecked.push('duplicate-id');
    for (const [id, n] of idCounts) {
        if (n > 1) c.add('duplicate-id', null, `id="${id}" ×${n}`);
    }

    // ── tabindex-positive ──
    rulesChecked.push('tabindex-positive');
    $('[tabindex]').each((_, el) => {
        const v = parseInt(_attr($(el), 'tabindex'), 10);
        if (Number.isFinite(v) && v > 0) c.add('tabindex-positive', el);
    });

    // ── meta-refresh ──
    rulesChecked.push('meta-refresh');
    $('meta[http-equiv]').each((_, el) => {
        const $el = $(el);
        if (_norm(_attr($el, 'http-equiv')).toLowerCase() !== 'refresh') return;
        const m = _norm(_attr($el, 'content')).match(/^(\d+)/);
        const delay = m ? Number(m[1]) : NaN;
        // An instant redirect (0) is not a timed refresh; anything with a
        // delay takes the page away from the reader on a clock.
        if (!m || delay > 0) c.add('meta-refresh', el);
    });

    // ── viewport-zoom ──
    rulesChecked.push('viewport-zoom');
    $('meta[name]').each((_, el) => {
        const $el = $(el);
        if (_norm(_attr($el, 'name')).toLowerCase() !== 'viewport') return;
        const content = _norm(_attr($el, 'content')).toLowerCase();
        const noScale = /user-scalable\s*=\s*(no|0)\b/.test(content);
        const maxScale = content.match(/maximum-scale\s*=\s*([\d.]+)/);
        if (noScale || (maxScale && Number(maxScale[1]) < 2)) c.add('viewport-zoom', el);
    });

    // ── media-autoplay ──
    rulesChecked.push('media-autoplay');
    $('video[autoplay], audio[autoplay]').each((_, el) => {
        const $el = $(el);
        // A muted autoplaying video has no audio to control (1.4.2).
        if (String(el.tagName).toLowerCase() === 'video' && _attr($el, 'muted') !== null) return;
        c.add('media-autoplay', el);
    });

    // ── table-headers ──
    rulesChecked.push('table-headers');
    $('table').each((_, el) => {
        const $el = $(el);
        if (_presentational($el) || _hidden($el)) return;
        if ($el.find('tr').length < 2) return; // layout/one-row tables are not data tables
        if ($el.find('th').length > 0) return;
        c.add('table-headers', el);
    });

    const errors = [];
    const warnings = [];
    for (const [rule, f] of c.findings) {
        const def = RULES[rule];
        const entry = { rule, wcag: def.wcag, count: f.count, samples: f.samples };
        (def.level === 'error' ? errors : warnings).push(entry);
    }
    errors.sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
    warnings.sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));

    return {
        errors,
        warnings,
        rules_checked: rulesChecked,
        rules_skipped: rulesSkipped,
        fragment,
        lang: declaredLang,
        version: VERSION,
    };
}

module.exports = { lint, RULES, VERSION };

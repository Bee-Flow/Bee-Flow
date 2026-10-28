// @typecheck
const { sanitizeContentForExport, escapeHtml } = require('../../../templates/exportTemplate');
const { markingText, markingFooterHtml } = require('./documentMarking');
const { ensureResolvedTheme, deckThemeCss, slideVariantStyle, slidesCss } = require('./deckThemeCss');
const { resolveDeckTheme, slideVariant } = require('../deckThemeOptions');
const { chartSvg } = require('../deckChartSvg');
const { iconSvg } = require('../deckIcons');

/** A template's overlay pictures, positioned by their slide fractions. */
function templateOverlaysHtml(side) {
    return (side && Array.isArray(side.overlays) ? side.overlays : [])
        .map((o) => `<img class="deck-overlay" src="${o.image}" alt="" style="left:${(o.x * 100).toFixed(2)}%;top:${(o.y * 100).toFixed(2)}%;width:${(o.w * 100).toFixed(2)}%;height:${(o.h * 100).toFixed(2)}%">`)
        .join('');
}

function slideSectionHtml({ bandTitle, body, style = null }, theme) {
    const t = deckThemeCss(theme);
    const brand = t.brandOnSlides && t.brandName ? `<div class="brand">${escapeHtml(t.brandName)}</div>` : '';
    const cls = style === 'accent' || style === 'dark' ? ` slide-${style}` : '';
    const overlays = t.template ? templateOverlaysHtml(t.template.content) : '';
    return `
<section class="slide${cls}"${slideVariantStyle(theme, style)}>${overlays}
  <header class="band"><div class="band-title">${bandTitle}</div>${brand}</header>
  <div class="slide-body">${body}</div>
</section>`;
}

/** @typedef {{ titleHtml: string, subtitle?: string, date?: string }} CoverSectionHtmlArgs */
/**
 * @param {CoverSectionHtmlArgs} param0
 */
function coverSectionHtml({ titleHtml, subtitle = '', date = '' }, theme) {
    const t = deckThemeCss(theme);
    const logo = t.logoDataUrl && t.logoPlacement !== 'none' ? `<img class="cover-logo" src="${t.logoDataUrl}" alt="">` : '';
    const overlays = t.template ? templateOverlaysHtml(t.template.cover) : '';
    return `
<section class="slide cover">${overlays}
  <div class="cover-canvas">${logo}</div>
  <div class="cover-block">
    <div class="cover-title">${titleHtml}</div>
    ${subtitle ? `<div class="cover-sub">${escapeHtml(subtitle)}</div>` : ''}
    <div class="cover-date">${escapeHtml(date)}</div>
  </div>
</section>`;
}

/** The per-page chrome: footer text, and the logo when it sits on every slide. */
function deckFooterHtml(theme) {
    const t = deckThemeCss(theme);
    /** @type {string[]} */
    const parts = [];
    if (t.logoDataUrl && (t.logoPlacement === 'footer' || t.logoPlacement === 'corner')) parts.push(`<img class="deck-logo" src="${t.logoDataUrl}" alt="">`);
    if (t.footerText) parts.push(`<div class="deck-footer">${escapeHtml(t.footerText)}</div>`);
    return parts.join('');
}

/** @typedef {{ title?: string, css: string, body: string }} SlidesDocumentArgs */
/**
 * @param {SlidesDocumentArgs} param0
 */
function slidesDocument({ title, css, body }) {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title || 'Document')}</title>
<style>${css}</style></head>
<body>${body}</body></html>`;
}

/**
 * @param {string} bodyHtml
 */
function buildSlidesHtml(bodyHtml, { title = '', author = '', date = '', marking = null, theme = null } = {}) {
    const stamp = date || new Date().toISOString().slice(0, 10);
    const html = String(bodyHtml);
    // Zero page margin means Chromium draws no footer chrome, so the marking
    // line lives in the slide itself: position:fixed repeats it on every page.
    const mark = markingFooterHtml(marking);

    // Split on every h2; what precedes the first one is cover material.
    const parts = html.split(/(?=<h2[\s>])/i);
    let head = parts.shift() ?? '';
    let coverTitle = '';
    head = head.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/i, (m, t) => { coverTitle = t; return ''; });
    const intro = head.trim();

    /** @type {{ bandTitle: string; body: string; }[]} */
    const slides = [];
    for (const part of parts) {
        let bandTitle = '';
        const body = part.replace(/^<h2[^>]*>([\s\S]*?)<\/h2>/i, (m, t) => { bandTitle = t; return ''; });
        slides.push({ bandTitle, body: body.trim() });
    }

    const cover = coverSectionHtml({ titleHtml: coverTitle || escapeHtml(title || 'Document'), subtitle: author, date: stamp }, theme);

    // Cover material that is not the title (a preamble paragraph) gets its own
    // page under the document title, so nothing an author wrote is dropped.
    const introSlide = intro
        ? slideSectionHtml({ bandTitle: coverTitle || escapeHtml(title || 'Inleiding'), body: intro }, theme)
        : '';

    return slidesDocument({
        title,
        css: slidesCss(theme),
        body: `${cover}${introSlide}${slides.map((s) => slideSectionHtml(s, theme)).join('')}${deckFooterHtml(theme)}${mark}`,
    });
}

/** `## Slide N` body HTML from a normalised deck slide (core/documents/deckModel.js). */
function deckSlideBodyHtml(s, theme = null) {
    const bullets = (list) => (list && list.length
        ? `<ul>${list.map((b) => `<li${b.level ? ' style="margin-left:6mm"' : ''}>${escapeHtml(b.text)}</li>`).join('')}</ul>`
        : '');
    const body = s.body ? sanitizeContentForExport(toHtml(s.body, 'markdown')) : '';
    /** @type {string[]} */
    const parts = [];
    // Visuals: the chart is an inline SVG drawn from the same theme the .pptx
    // chart is coloured with; text sits beside it when the slide has any.
    if (s.layout === 'chart' && s.chart) {
        const th = s.style ? slideVariant(ensureResolvedTheme(theme) || resolveDeckTheme(null), s.style) : (ensureResolvedTheme(theme) || resolveDeckTheme(null));
        const fig = `<figure class="deck-chart">${chartSvg(s.chart, th)}</figure>`;
        const text = `${body}${bullets(s.bullets)}`;
        return text ? `<div class="deck-split"><div class="deck-side">${text}</div>${fig}</div>` : fig;
    }
    if (s.layout === 'stats' && s.stats) {
        const sth = ensureResolvedTheme(theme) || resolveDeckTheme(null);
        const sAccent = (s.style ? slideVariant(sth, s.style) : sth).accentOnSlide;
        parts.push(`<div class="deck-stats">${s.stats.map((t) => `<div class="deck-stat">${t.icon ? `<div class="deck-stat-icon">${iconSvg(t.icon, sAccent, { size: 22 })}</div>` : ''}<div class="deck-stat-value">${escapeHtml(t.value)}</div>`
            + `${t.label ? `<div class="deck-stat-label">${escapeHtml(t.label)}</div>` : ''}${t.delta ? `<div class="deck-stat-delta">${escapeHtml(t.delta)}</div>` : ''}</div>`).join('')}</div>`);
        if (body) parts.push(body);
        parts.push(bullets(s.bullets));
        return parts.join('');
    }
    if (s.layout === 'cards' && s.cards) {
        if (body) parts.push(body);
        const th = ensureResolvedTheme(theme) || resolveDeckTheme(null);
        const accent = (s.style ? slideVariant(th, s.style) : th).accentOnSlide;
        parts.push(`<div class="deck-cards deck-cards-${s.cards.length}">${s.cards.map((c) => `<div class="deck-card${c.image || c.icon ? ' deck-card-media' : ''}">`
            + (c.image && c.image.dataUrl ? `<img class="deck-card-image" src="${c.image.dataUrl}" alt="${escapeHtml(c.image.alt || '')}">` : (c.icon ? `<div class="deck-card-icon">${iconSvg(c.icon, accent, { size: 28 })}</div>` : ''))
            + `${c.title ? `<div class="deck-card-title">${escapeHtml(c.title)}</div>` : ''}${c.text ? `<div class="deck-card-text">${escapeHtml(c.text).replace(/\n/g, '<br>')}</div>` : ''}</div>`).join('')}</div>`);
        return parts.join('');
    }
    if (s.layout === 'timeline' && s.steps) {
        parts.push(`<ol class="deck-timeline">${s.steps.map((st, i) => `<li><span class="deck-step-n">${i + 1}</span><div class="deck-step-title">${escapeHtml(st.title)}</div>`
            + `${st.text ? `<div class="deck-step-text">${escapeHtml(st.text)}</div>` : ''}</li>`).join('')}</ol>`);
        if (body) parts.push(body);
        return parts.join('');
    }
    if (s.layout === 'quote' && s.quote) {
        parts.push(`<div class="deck-quote-mark">“</div><blockquote class="deck-quote">${escapeHtml(s.quote.text)}</blockquote>`);
        if (s.quote.attribution) parts.push(`<p class="deck-quote-by">${escapeHtml(s.quote.attribution)}</p>`);
    }
    if (s.layout === 'two_column' && s.columns) {
        parts.push(`<div class="deck-columns">${s.columns.map((c) => `<div>${c.title ? `<h3>${escapeHtml(c.title)}</h3>` : ''}${bullets(c.bullets)}</div>`).join('')}</div>`);
        if (body) parts.push(body);
        return parts.join('');
    }
    if (s.table) {
        const t = s.table;
        parts.push(`<table><thead><tr>${t.columns.map((c) => `<th>${escapeHtml(String(c))}</th>`).join('')}</tr></thead>`
            + `<tbody>${t.rows.map((r) => `<tr>${r.map((v) => `<td>${escapeHtml(String(v ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    }
    // Only inline bytes survive: the sanitiser blanks every remote src, and
    // the deck model has already refused http(s) references.
    if (s.image && s.image.dataUrl) parts.push(`<img class="deck-image" src="${s.image.dataUrl}" alt="${escapeHtml(s.image.alt || '')}">`);
    if (body) parts.push(body);
    if (s.layout !== 'quote' || !s.quote) parts.push(bullets(s.bullets));
    return parts.join('');
}

/**
 * The on-screen viewer's extra layer: the same slides, laid out as scaled
 * cards on a dark desk instead of as pages. Everything print mode positions
 * with `position: fixed` (the footer, the logo, the marking line) is placed
 * INSIDE each slide here, because fixed means "once, on the viewport" on a
 * screen and "on every page" only on paper.
 */
const SCREEN_DECK_CSS = `
  html { background: #23262b; }
  body { background: transparent; }
  .deck-viewer { padding: 18px 16px 48px; display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .deck-frame { position: relative; overflow: hidden; border-radius: 6px; box-shadow: 0 6px 24px rgba(0,0,0,.35); background: var(--deck-bg); flex: none; }
  .deck-frame > .slide { transform-origin: top left; }
  .deck-frame:focus { outline: 2px solid rgba(255,255,255,.6); outline-offset: 2px; }
  .slide, .cover { width: 297mm; height: 210mm; min-height: 0; overflow: hidden; page-break-after: auto; }
  .deck-footer, .deck-logo, .ai-mark { position: absolute; }
  .deck-footer { left: 14mm; right: auto; bottom: 5mm; max-width: 200mm; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .deck-number { position: absolute; right: 14mm; bottom: 5mm; font-size: 8pt; color: var(--deck-muted); }
  .deck-count { color: rgba(255,255,255,.55); font: 12px/1.4 system-ui, sans-serif; letter-spacing: .3px; }
`;

/**
 * The viewer's script: fit every slide to the width it has (an iframe beside a
 * chat, a full screen), step through them with the keyboard, and tell the
 * parent frame it is up. Inline, because the preview route's CSP allows no
 * external script — and there is nothing here worth a file.
 */
const SCREEN_DECK_SCRIPT = `<script>(function(){
  var W = 297 / 25.4 * 96, H = 210 / 25.4 * 96;
  var frames = Array.prototype.slice.call(document.querySelectorAll('.deck-frame'));
  function fit() {
    var avail = Math.max(120, document.documentElement.clientWidth - 32);
    var s = Math.min(1, avail / W);
    frames.forEach(function (f) {
      f.style.width = (W * s) + 'px'; f.style.height = (H * s) + 'px';
      var slide = f.firstElementChild; if (slide) slide.style.transform = 'scale(' + s + ')';
    });
  }
  function go(delta) {
    var top = document.documentElement.scrollTop || document.body.scrollTop;
    var i = 0;
    for (var k = 0; k < frames.length; k++) { if (frames[k].offsetTop - 24 <= top) i = k; }
    var next = frames[Math.max(0, Math.min(frames.length - 1, i + delta))];
    if (next) { next.scrollIntoView({ behavior: 'smooth', block: 'start' }); try { next.focus({ preventScroll: true }); } catch (_) { console.debug("focus failed", _); } }
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); go(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); go(-1); }
    else if (e.key === 'Home') { e.preventDefault(); go(-frames.length); }
    else if (e.key === 'End') { e.preventDefault(); go(frames.length); }
  });
  window.addEventListener('resize', fit);
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var d = e && e.data;
    if (d && d.__beeflowDeckGoto === true && typeof d.index === 'number' && frames[d.index]) frames[d.index].scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  fit();
  try { parent.postMessage({ __beeflowDeckReady: true, slideCount: frames.length }, '*'); } catch (_) { console.debug("parent gone", _); }
})();<\/script>`;

/** The per-slide chrome of the viewer: logo, footer line, marking, the number. */
function screenChromeHtml(theme, marking, index, _total) {
    const t = deckThemeCss(theme);
    /** @type {string[]} */
    const parts = [];
    const logo = t.logoDataUrl && (t.logoPlacement === 'footer' || t.logoPlacement === 'corner');
    if (logo) parts.push(`<img class="deck-logo" src="${t.logoDataUrl}" alt="">`);
    const line = [t.footerText || t.brandName, markingText(marking)].filter(Boolean).join('  ·  ');
    // The footer line starts after the logo when the logo sits in the footer:
    // its width follows from its aspect (7mm high), 2.5:1 when unmeasured.
    const left = logo && t.logoPlacement === 'footer' ? `left:${(14 + 7 * (t.logoAspect || 2.5) + 3).toFixed(1)}mm;` : '';
    // On an accent-block cover the line is written in the on-accent colour,
    // as the .pptx cover master does; a template cover keeps its own text.
    const onAccent = index === 0 && !t.template && t.coverStyle === 'accent' ? `color:${t.onAccent};opacity:.75;` : '';
    const style = left || onAccent ? ` style="${left}${onAccent}"` : '';
    if (line) parts.push(`<div class="deck-footer"${style}>${escapeHtml(line)}</div>`);
    if (t.slideNumbers && index > 0) parts.push(`<div class="deck-number">${index + 1}</div>`);
    return parts.join('');
}

/**
 * The PDF deck for a NORMALISED deck — the same structure officegen turns into
 * a .pptx, so `format:'pdf'` on the presentation step is the same deck on
 * paper. Speaker notes are not printed (a PDF has no notes pane).
 *
 * `mode: 'screen'` is the viewer the Documents editor and the chat's side
 * panel show: the same sections, each wrapped as a scaled card, so what a
 * person sees on screen is the PDF's page and the .pptx's slide.
 */
function deckToSlidesHtml(deck, { theme = null, marking = null, date = '', title = '', mode = 'print' } = {}) {
    const screen = mode === 'screen';
    const stamp = date || deck.date || new Date().toISOString().slice(0, 10);
    const cover = coverSectionHtml({
        titleHtml: escapeHtml(title || deck.title || 'Presentation'),
        subtitle: [deck.subtitle, deck.author].filter(Boolean).join(' · '),
        date: stamp,
    }, theme);
    const t = deckThemeCss(theme);
    const slides = deck.slides.map((s) => {
        if (s.layout === 'section') {
            return `<section class="slide"><div class="slide-body" style="padding-top:70mm"><h2 style="color:var(--deck-accent);font-size:26pt;margin:0 0 4mm">${escapeHtml(s.title)}</h2>`
                + `${s.body ? `<p style="color:var(--deck-muted);font-size:13pt">${escapeHtml(s.body)}</p>` : ''}</div></section>`;
        }
        if (s.layout === 'closing' || s.layout === 'title') {
            return coverSectionHtml({ titleHtml: escapeHtml(s.title || 'Thank you'), subtitle: [s.body, ...s.bullets.map((b) => b.text)].filter(Boolean).join(' · '), date: '' }, theme);
        }
        return slideSectionHtml({ bandTitle: escapeHtml(s.title || ''), body: deckSlideBodyHtml(s, theme), style: s.style }, theme);
    });
    if (!screen) {
        return slidesDocument({
            title: title || deck.title,
            css: slidesCss(t),
            body: `${cover}${slides.join('')}${deckFooterHtml(t)}${markingFooterHtml(marking)}`,
        });
    }
    const all = [cover, ...slides];
    // The chrome goes INSIDE each section (before its closing tag) so it is
    // positioned against the slide, not the desk.
    const framed = all.map((html, i) => {
        const withChrome = html.replace(/<\/section>\s*$/, `${screenChromeHtml(t, marking, i, all.length)}</section>`);
        return `<div class="deck-frame" tabindex="0" data-slide="${i + 1}" aria-label="Slide ${i + 1} of ${all.length}">${withChrome}</div>`;
    });
    return slidesDocument({
        title: title || deck.title,
        css: slidesCss(t) + SCREEN_DECK_CSS,
        body: `<div class="deck-viewer">${framed.join('')}<div class="deck-count">${all.length} ${all.length === 1 ? 'slide' : 'slides'}</div></div>${SCREEN_DECK_SCRIPT}`,
    });
}

/** Plain lines for the pdfkit fallback of a deck. */
function deckToPlainText(deck) {
    /** @type {string[]} */
    const lines = [];
    for (const s of deck.slides) {
        lines.push(`## ${s.title || ''}`);
        if (s.body) lines.push(s.body);
        for (const b of s.bullets) lines.push(`${b.level ? '  ' : ''}- ${b.text}`);
        if (s.quote) lines.push(`> ${s.quote.text}${s.quote.attribution ? ` — ${s.quote.attribution}` : ''}`);
        if (s.table) { lines.push(s.table.columns.join(' | ')); for (const r of s.table.rows) lines.push(r.join(' | ')); }
        if (s.chart) {
            lines.push(`Chart (${s.chart.type}):`);
            for (const ser of s.chart.series) lines.push(`${ser.name ? `${ser.name}: ` : ''}${s.chart.labels.map((l, i) => `${l} = ${ser.values[i] ?? '–'}`).join(', ')}`);
        }
        if (s.stats) for (const t of s.stats) lines.push(`${t.value} ${t.label}${t.delta ? ` (${t.delta})` : ''}`);
        if (s.steps) s.steps.forEach((st, i) => lines.push(`${i + 1}. ${st.title}${st.text ? ` — ${st.text}` : ''}`));
        if (s.cards) for (const c of s.cards) lines.push(`${c.title || ''}${c.title && c.text ? ': ' : ''}${c.text || ''}`);
        lines.push('');
    }
    return lines.join('\n');
}

/**
 * markdown → HTML. Already-HTML content passes through untouched.
 * @param {string} content
 * @param {string} contentFormat
 */
function toHtml(content, contentFormat) {
    const text = String(content ?? '');
    if (contentFormat === 'html') return text;
    const { marked } = require('marked');
    // No `mangle`/`headerIds` extras: the output is print material, not a page
    // with anchors, and gfm gives tables + strikethrough which authors expect.
    return marked.parse(text, { gfm: true, breaks: false, async: false });
}

module.exports = { buildSlidesHtml, deckToSlidesHtml, deckToPlainText, toHtml };

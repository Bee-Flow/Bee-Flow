/**
 * Social-card definitions for the marketing site's og:images.
 *
 * WHY THESE EXIST: every page shipped an SVG as its og:image, and LinkedIn,
 * X, Slack and WhatsApp render no SVG previews — so every shared Bee Flow
 * link showed an empty card, on exactly the channel a developer tool lives
 * or dies by. These cards are rendered to 1200×630 PNGs by
 * ../renderOgImages.js and committed under ./og/, so the container never
 * has to rasterise anything (a slim image has no fonts to do it with).
 *
 * Six category cards rather than thirty-four page cards: the goal is a
 * legible, on-brand preview, not a thumbnail of the page. Page → card
 * mapping lives with the pages in beeflowSite.js.
 *
 * Re-render after editing: node scripts/renderOgImages.js  (from server/)
 */

// The brand palette, copied from the design block in beeflowSite.js. Values,
// not imports: this module must stay loadable without pulling in the whole
// site bundle.
const C = {
    bg: '#141317',
    surface: '#1C1B21',
    amber: '#F5A623',
    amberSoft: '#FFD166',
    text: '#F4F2EE',
    textDim: '#A6A29A',
};

const OG_CARDS = Object.freeze({
    workspace: {
        file: 'og-workspace.png',
        lines: ['The European, self-hostable', 'AI workspace'],
        footer: 'beeflow.nl · agents, automations and knowledge in one place',
    },
    privacy: {
        file: 'og-privacy.png',
        lines: ['Privacy you can watch', 'working'],
        footer: 'beeflow.nl · on-premise PII detection, tokenise and restore',
    },
    security: {
        file: 'og-security.png',
        lines: ['Zero-knowledge encryption.', 'Identity from your IdP.'],
        footer: 'beeflow.nl · security, SSO and compliance evidence',
    },
    compare: {
        file: 'og-compare.png',
        lines: ['Honest comparisons —', 'including where we lose'],
        footer: 'beeflow.nl · Microsoft, n8n, Zapier, ChatGPT and more',
    },
    feature: {
        file: 'og-feature.png',
        lines: ['Work that runs on', 'infrastructure you control'],
        footer: 'beeflow.nl · self-hosted or managed EU cloud',
    },
    company: {
        file: 'og-company.png',
        lines: ['Built in the Netherlands.', 'Auditable line by line.'],
        footer: 'beeflow.nl · source-available, fair-code',
    },
});

/** One hexagon outline, flat-top, centred on (cx, cy). */
function hex(cx, cy, r, stroke, width, opacity) {
    const pts = [];
    for (let i = 0; i < 6; i += 1) {
        const a = (Math.PI / 180) * (60 * i);
        pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
    }
    return `<polygon points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="${width}" opacity="${opacity}"/>`;
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The 1200×630 card as an SVG string. Georgia for the display line (the
 * closest universally-installed face to the site's Fraunces) and Segoe
 * UI/Arial for the small text — the renderer runs on a workstation, so
 * these resolve to real fonts there and the committed PNG carries them.
 */
function buildOgCardSvg(card) {
    const titleLines = card.lines
        .map((line, i) => `<text x="80" y="${300 + i * 84}" font-family="Georgia, 'Times New Roman', serif" font-size="64" font-weight="bold" fill="${C.text}">${esc(line)}</text>`)
        .join('\n    ');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${C.bg}"/>
  <rect width="1200" height="630" fill="url(#sheen)"/>
  <defs>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.surface}" stop-opacity="0.9"/>
      <stop offset="1" stop-color="${C.bg}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  ${hex(1050, 140, 190, C.amber, 3, 0.35)}
  ${hex(1050, 140, 130, C.amber, 3, 0.55)}
  ${hex(1050, 140, 70, C.amber, 3, 0.9)}
  ${hex(880, 470, 110, C.amberSoft, 2, 0.18)}
  ${hex(1120, 520, 80, C.amberSoft, 2, 0.14)}
  <circle cx="1050" cy="140" r="14" fill="${C.amber}"/>
  <text x="80" y="120" font-family="Georgia, 'Times New Roman', serif" font-size="44" font-weight="bold" fill="${C.text}">Bee Flow<tspan fill="${C.amber}">.</tspan></text>
  <rect x="80" y="168" width="72" height="5" rx="2.5" fill="${C.amber}"/>
    ${titleLines}
  <text x="80" y="552" font-family="'Segoe UI', Arial, sans-serif" font-size="26" fill="${C.textDim}">${esc(card.footer)}</text>
</svg>`;
}

module.exports = { OG_CARDS, buildOgCardSvg };

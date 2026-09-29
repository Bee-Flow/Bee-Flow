/**
 * Hand-authored SVG artwork for the seeded Bee Flow website.
 *
 * There are no product screenshots in this repo, and inventing "screenshots"
 * of a UI would be a lie in image form. So the site ships diagrams and brand
 * marks instead: each one describes something the code actually does (the
 * service topology, the DLP path a prompt takes, the retrieval pipeline),
 * drawn from the same sources as the copy.
 *
 * These are plain strings so they can be reviewed in a diff. The seeder
 * pushes them through the SAME sanitize-then-store path an admin upload
 * takes — no <script>, no event handlers, no external references, which is
 * also what lets the asset endpoint serve them inline rather than forcing a
 * download.
 *
 * Colours are the real brand values (agent-hub/src/marketing/HomePage.jsx:18
 * and the european-warmth preset), and every diagram uses `currentColor`-free
 * explicit fills so it renders identically in light and dark bands.
 */

const AMBER = '#F5A623';
const AMBER_DEEP = '#E0941A';
const INK = '#1C1917';
const MUTED = '#78716C';
const HAIRLINE = '#E7E5E4';
const SURFACE = '#FAF8F4';

/** A honeycomb cell path centred on (cx, cy) with circumradius r. */
function hex(cx, cy, r) {
    const pts = [];
    for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i - 30);
        pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(' ');
}

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Bee Flow">
  <polygon points="${hex(32, 32, 30)}" fill="${AMBER}"/>
  <polygon points="${hex(32, 32, 21)}" fill="${AMBER_DEEP}" opacity="0.35"/>
  <path d="M24 18h11a9 9 0 0 1 1.6 17.9A9.5 9.5 0 0 1 35.5 46H24Zm7 4v8h4a4 4 0 0 0 0-8Zm0 12v8h4.2a4 4 0 0 0 0-8Z" fill="${INK}"/>
</svg>`;

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Bee Flow">
  <polygon points="${hex(16, 16, 15)}" fill="${AMBER}"/>
  <path d="M11 8h6a4.6 4.6 0 0 1 1 9.1A4.8 4.8 0 0 1 17.2 24H11Zm3.5 2.6v4.2h2.2a2.1 2.1 0 0 0 0-4.2Zm0 6.6v4.2h2.4a2.1 2.1 0 0 0 0-4.2Z" fill="${INK}"/>
</svg>`;

/**
 * Service topology — mirrors docker-compose.from-registry.yml profiles and
 * the hosted deployment, i.e. what actually gets deployed.
 */
const ARCHITECTURE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 460" role="img" aria-label="Bee Flow service architecture">
  <rect width="880" height="460" fill="${SURFACE}"/>
  <g font-family="Inter, system-ui, sans-serif">
    <rect x="40" y="32" width="800" height="76" rx="14" fill="#FFFFFF" stroke="${HAIRLINE}"/>
    <text x="64" y="62" font-size="15" font-weight="600" fill="${INK}">Agent Hub — React 19 SPA</text>
    <text x="64" y="86" font-size="13" fill="${MUTED}">Chat · Studio · Admin · Product website renderer</text>
    <rect x="700" y="50" width="116" height="40" rx="10" fill="${AMBER}" opacity="0.18"/>
    <text x="758" y="75" font-size="12" font-weight="600" fill="${INK}" text-anchor="middle">Browser</text>

    <path d="M440 108 L440 140" stroke="${MUTED}" stroke-width="1.5" stroke-dasharray="4 4"/>

    <rect x="40" y="140" width="800" height="96" rx="14" fill="#FFFFFF" stroke="${HAIRLINE}"/>
    <text x="64" y="170" font-size="15" font-weight="600" fill="${INK}">Server — Node 22 / Express 5</text>
    <text x="64" y="194" font-size="13" fill="${MUTED}">Agent runtime · automations · RAG · MCP · licensing · CMS</text>
    <text x="64" y="216" font-size="12" fill="${MUTED}">6 LLM provider adapters + any OpenAI-compatible endpoint</text>

    <path d="M200 236 L200 268 M440 236 L440 268 M680 236 L680 268" stroke="${MUTED}" stroke-width="1.5" stroke-dasharray="4 4"/>

    <rect x="40" y="268" width="240" height="88" rx="12" fill="#FFFFFF" stroke="${HAIRLINE}"/>
    <text x="60" y="296" font-size="14" font-weight="600" fill="${INK}">Guard service</text>
    <text x="60" y="318" font-size="12" fill="${MUTED}">GLiNER PII detection</text>
    <text x="60" y="336" font-size="12" fill="${MUTED}">CPU · Apache-2.0 model</text>

    <rect x="320" y="268" width="240" height="88" rx="12" fill="#FFFFFF" stroke="${HAIRLINE}"/>
    <text x="340" y="296" font-size="14" font-weight="600" fill="${INK}">Search &amp; reranker</text>
    <text x="340" y="318" font-size="12" fill="${MUTED}">Extraction · chunking</text>
    <text x="340" y="336" font-size="12" fill="${MUTED}">Cross-encoder rerank</text>

    <rect x="600" y="268" width="240" height="88" rx="12" fill="#FFFFFF" stroke="${HAIRLINE}"/>
    <text x="620" y="296" font-size="14" font-weight="600" fill="${INK}">WhisperX</text>
    <text x="620" y="318" font-size="12" fill="${MUTED}">Transcription + diarisation</text>
    <text x="620" y="336" font-size="12" fill="${MUTED}">GPU · optional profile</text>

    <rect x="40" y="380" width="800" height="60" rx="12" fill="${AMBER}" opacity="0.14"/>
    <text x="64" y="408" font-size="14" font-weight="600" fill="${INK}">PostgreSQL + pgvector · S3-compatible object storage · Redis</text>
    <text x="64" y="428" font-size="12" fill="${MUTED}">Your infrastructure, your region — nothing here is hosted for you unless you ask for it</text>
  </g>
</svg>`;

/**
 * What Privacy Shield does to an outbound prompt. Every stage is real:
 * see server/core/piiDetection.js and server/core/dlp/.
 */
const PRIVACY_FLOW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 300" role="img" aria-label="How Privacy Shield handles an outbound prompt">
  <rect width="880" height="300" fill="${SURFACE}"/>
  <g font-family="Inter, system-ui, sans-serif">
    <rect x="24" y="96" width="180" height="108" rx="12" fill="#FFFFFF" stroke="${HAIRLINE}"/>
    <text x="44" y="128" font-size="14" font-weight="600" fill="${INK}">Your prompt</text>
    <text x="44" y="152" font-size="12" fill="${MUTED}">&quot;Draft a reply to</text>
    <text x="44" y="170" font-size="12" fill="${MUTED}">j.jansen@acme.nl</text>
    <text x="44" y="188" font-size="12" fill="${MUTED}">about invoice 2026-114&quot;</text>

    <path d="M204 150 L244 150" stroke="${MUTED}" stroke-width="1.5" marker-end="url(#arrow)"/>

    <rect x="244" y="80" width="196" height="140" rx="12" fill="#FFFFFF" stroke="${AMBER}" stroke-width="2"/>
    <text x="264" y="112" font-size="14" font-weight="600" fill="${INK}">Guard service</text>
    <text x="264" y="136" font-size="12" fill="${MUTED}">21 PII categories</text>
    <text x="264" y="156" font-size="12" fill="${MUTED}">Runs on your hardware</text>
    <text x="264" y="176" font-size="12" fill="${MUTED}">BSN checked by elfproef</text>
    <text x="264" y="200" font-size="12" fill="${AMBER_DEEP}" font-weight="600">block · redact · ask · tokenize</text>

    <path d="M440 150 L480 150" stroke="${MUTED}" stroke-width="1.5" marker-end="url(#arrow)"/>

    <rect x="480" y="96" width="180" height="108" rx="12" fill="#FFFFFF" stroke="${HAIRLINE}"/>
    <text x="500" y="128" font-size="14" font-weight="600" fill="${INK}">What leaves</text>
    <text x="500" y="152" font-size="12" fill="${MUTED}">&quot;Draft a reply to</text>
    <text x="500" y="170" font-size="12" fill="${AMBER_DEEP}">[email_1]</text>
    <text x="500" y="188" font-size="12" fill="${MUTED}">about invoice 2026-114&quot;</text>

    <path d="M660 150 L700 150" stroke="${MUTED}" stroke-width="1.5" marker-end="url(#arrow)"/>

    <rect x="700" y="96" width="156" height="108" rx="12" fill="${AMBER}" opacity="0.16"/>
    <text x="720" y="128" font-size="14" font-weight="600" fill="${INK}">Model</text>
    <text x="720" y="152" font-size="12" fill="${MUTED}">Cloud or local.</text>
    <text x="720" y="170" font-size="12" fill="${MUTED}">Local models skip</text>
    <text x="720" y="188" font-size="12" fill="${MUTED}">the shield entirely.</text>

    <text x="24" y="264" font-size="12" fill="${MUTED}">Real values are restored in the answer you read — the placeholder never reaches you.</text>
    <text x="24" y="284" font-size="12" fill="${MUTED}">If the guard is unreachable, the request is blocked rather than sent unchecked.</text>
  </g>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="${MUTED}"/>
    </marker>
  </defs>
</svg>`;

/**
 * The retrieval pipeline — server/core/chunkContent.js, embed/dispatch.js,
 * the RRF hybrid and the three-tier rerank chain.
 */
const KNOWLEDGE_FLOW = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 300" role="img" aria-label="How a question finds an answer in your knowledge base">
  <rect width="880" height="300" fill="${SURFACE}"/>
  <g font-family="Inter, system-ui, sans-serif">
    <rect x="24" y="60" width="168" height="180" rx="12" fill="#FFFFFF" stroke="${HAIRLINE}"/>
    <text x="44" y="92" font-size="14" font-weight="600" fill="${INK}">Your sources</text>
    <text x="44" y="120" font-size="12" fill="${MUTED}">PDF · DOCX · XLSX</text>
    <text x="44" y="142" font-size="12" fill="${MUTED}">Markdown · HTML · CSV</text>
    <text x="44" y="164" font-size="12" fill="${MUTED}">Email (.eml)</text>
    <text x="44" y="186" font-size="12" fill="${MUTED}">Websites</text>
    <text x="44" y="208" font-size="12" fill="${MUTED}">Nextcloud folders</text>

    <path d="M192 150 L232 150" stroke="${MUTED}" stroke-width="1.5" marker-end="url(#arrow2)"/>

    <rect x="232" y="60" width="168" height="180" rx="12" fill="#FFFFFF" stroke="${HAIRLINE}"/>
    <text x="252" y="92" font-size="14" font-weight="600" fill="${INK}">Chunk &amp; embed</text>
    <text x="252" y="120" font-size="12" fill="${MUTED}">Token-aware chunking</text>
    <text x="252" y="142" font-size="12" fill="${MUTED}">Near-duplicate removal</text>
    <text x="252" y="164" font-size="12" fill="${MUTED}">Embeddings in-process</text>
    <text x="252" y="186" font-size="12" fill="${MUTED}">on CPU if you have</text>
    <text x="252" y="208" font-size="12" fill="${MUTED}">no provider configured</text>

    <path d="M400 150 L440 150" stroke="${MUTED}" stroke-width="1.5" marker-end="url(#arrow2)"/>

    <rect x="440" y="60" width="168" height="180" rx="12" fill="#FFFFFF" stroke="${AMBER}" stroke-width="2"/>
    <text x="460" y="92" font-size="14" font-weight="600" fill="${INK}">Hybrid retrieval</text>
    <text x="460" y="120" font-size="12" fill="${MUTED}">Vector search (pgvector)</text>
    <text x="460" y="142" font-size="12" fill="${MUTED}">+ BM25 keyword search</text>
    <text x="460" y="164" font-size="12" fill="${MUTED}">fused with RRF</text>
    <text x="460" y="192" font-size="12" fill="${AMBER_DEEP}" font-weight="600">then reranked by a</text>
    <text x="460" y="210" font-size="12" fill="${AMBER_DEEP}" font-weight="600">cross-encoder</text>

    <path d="M608 150 L648 150" stroke="${MUTED}" stroke-width="1.5" marker-end="url(#arrow2)"/>

    <rect x="648" y="60" width="208" height="180" rx="12" fill="${AMBER}" opacity="0.16"/>
    <text x="668" y="92" font-size="14" font-weight="600" fill="${INK}">Answer with citations</text>
    <text x="668" y="120" font-size="12" fill="${MUTED}">Numbered source cards</text>
    <text x="668" y="142" font-size="12" fill="${MUTED}">back every claim, so a</text>
    <text x="668" y="164" font-size="12" fill="${MUTED}">reader can check the</text>
    <text x="668" y="186" font-size="12" fill="${MUTED}">document instead of</text>
    <text x="668" y="208" font-size="12" fill="${MUTED}">trusting the model.</text>
  </g>
  <defs>
    <marker id="arrow2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="${MUTED}"/>
    </marker>
  </defs>
</svg>`;

/**
 * The generic hero / share-card fallback, used wherever a real screenshot has
 * not been supplied (and as og:image on half the site).
 *
 * It used to be a 6×7 grid of hexagons with `(row * 7 + col) % 5` picking which
 * ones were amber. A modulo pattern does not read as a considered composition —
 * it reads as filler, which is exactly what it was, and it put a beehive motif
 * in front of people evaluating an automation platform.
 *
 * This draws the thing the product actually is: a workflow. A trigger, three
 * steps with one branch, an approval gate and an endpoint, on a faint canvas
 * grid. Deliberately unlabelled — no invented step names, no fake UI chrome,
 * nothing a reader could mistake for a screenshot of a feature that does not
 * exist. It is legible at og:image size (1200×630 crops from 800×500) because
 * the shapes are large and the palette is two colours plus hairlines.
 */
const HIVE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 500" role="img" aria-label="">
  <defs>
    <linearGradient id="hv-wash" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="${SURFACE}"/>
    </linearGradient>
    <linearGradient id="hv-node" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF"/>
      <stop offset="1" stop-color="#FCFAF7"/>
    </linearGradient>
    <linearGradient id="hv-amber" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${AMBER}"/>
      <stop offset="1" stop-color="${AMBER_DEEP}"/>
    </linearGradient>
    <pattern id="hv-grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0H0V40" fill="none" stroke="${HAIRLINE}" stroke-width="1" opacity="0.55"/>
    </pattern>
  </defs>

  <rect width="800" height="500" fill="url(#hv-wash)"/>
  <rect width="800" height="500" fill="url(#hv-grid)"/>

  <!-- connectors, drawn under the nodes so they tuck behind the cards -->
  <g fill="none" stroke="${HAIRLINE}" stroke-width="2.5" stroke-linecap="round">
    <path d="M212 250 H268"/>
    <path d="M420 214 C452 214 452 150 484 150"/>
    <path d="M420 286 C452 286 452 350 484 350"/>
    <path d="M636 150 C668 150 668 250 700 250"/>
    <path d="M636 350 C668 350 668 250 700 250"/>
  </g>
  <!-- the live path: one route through the flow, in brand amber -->
  <g fill="none" stroke="url(#hv-amber)" stroke-width="3" stroke-linecap="round">
    <path d="M212 250 H268"/>
    <path d="M420 214 C452 214 452 150 484 150"/>
    <path d="M636 150 C668 150 668 250 700 250"/>
  </g>

  <!-- trigger -->
  <g>
    <rect x="72" y="222" width="140" height="56" rx="16" fill="url(#hv-amber)"/>
    <circle cx="104" cy="250" r="9" fill="#FFFFFF" opacity="0.92"/>
    <rect x="124" y="242" width="66" height="7" rx="3.5" fill="#FFFFFF" opacity="0.92"/>
    <rect x="124" y="255" width="44" height="6" rx="3" fill="#FFFFFF" opacity="0.6"/>
  </g>

  <!-- branch point -->
  <g>
    <rect x="268" y="206" width="152" height="88" rx="18" fill="url(#hv-node)" stroke="${HAIRLINE}" stroke-width="1.5"/>
    <rect x="290" y="230" width="20" height="20" rx="6" fill="${AMBER}" opacity="0.25"/>
    <rect x="290" y="238" width="20" height="4" rx="2" fill="${AMBER}"/>
    <rect x="322" y="231" width="76" height="7" rx="3.5" fill="${INK}" opacity="0.72"/>
    <rect x="322" y="244" width="52" height="6" rx="3" fill="${MUTED}" opacity="0.5"/>
    <rect x="290" y="266" width="108" height="6" rx="3" fill="${MUTED}" opacity="0.3"/>
  </g>

  <!-- upper branch: the taken path -->
  <g>
    <rect x="484" y="118" width="152" height="64" rx="16" fill="url(#hv-node)" stroke="${AMBER}" stroke-width="2"/>
    <circle cx="512" cy="150" r="10" fill="${AMBER}" opacity="0.22"/>
    <path d="M507 150 l4 4 l7 -8" fill="none" stroke="${AMBER_DEEP}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="532" y="141" width="78" height="7" rx="3.5" fill="${INK}" opacity="0.72"/>
    <rect x="532" y="154" width="50" height="6" rx="3" fill="${MUTED}" opacity="0.5"/>
  </g>

  <!-- lower branch: the untaken path, held back -->
  <g opacity="0.55">
    <rect x="484" y="318" width="152" height="64" rx="16" fill="url(#hv-node)" stroke="${HAIRLINE}" stroke-width="1.5"/>
    <circle cx="512" cy="350" r="10" fill="${MUTED}" opacity="0.16"/>
    <rect x="532" y="341" width="64" height="7" rx="3.5" fill="${INK}" opacity="0.5"/>
    <rect x="532" y="354" width="42" height="6" rx="3" fill="${MUTED}" opacity="0.4"/>
  </g>

  <!-- endpoint -->
  <g>
    <circle cx="716" cy="250" r="26" fill="#FFFFFF" stroke="${HAIRLINE}" stroke-width="1.5"/>
    <circle cx="716" cy="250" r="9" fill="url(#hv-amber)"/>
  </g>
</svg>`;

/**
 * key → svg source. Keys are stable (no timestamp) so re-running the seeder
 * reuses the same objects instead of littering storage with copies.
 */
const ASSETS = {
    'cms/beeflow-logo.svg': LOGO,
    'cms/beeflow-favicon.svg': FAVICON,
    'cms/beeflow-architecture.svg': ARCHITECTURE,
    'cms/beeflow-privacy-flow.svg': PRIVACY_FLOW,
    'cms/beeflow-knowledge-flow.svg': KNOWLEDGE_FLOW,
    'cms/beeflow-hive.svg': HIVE,
};

// ── Screenshots ──────────────────────────────────────────────────────
//
// Product screenshots the operator supplies by dropping PNGs into
// ./screenshots/. They are NOT in the repo: they are captured from the live
// demo routes (/__demo__/<feature>), which run on fixtures — so a shot of one
// cannot contain a real customer, a real mailbox or a real org name. A shot
// of /app/… can, which is why the plan says to shoot the demos.
//
// EVERY ONE IS OPTIONAL. `resolveScreenshots()` returns only the files that
// actually exist, and the content module asks for a key through
// `shot(name)` — which yields '' when the file is absent, so the block falls
// back to a text-only layout instead of drawing an empty placeholder frame.
// That is the whole point: a missing screenshot must never look like a bug.

const fs = require('fs');
const path = require('path');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

/** name (no extension) → the storage key it will be uploaded under. */
const SCREENSHOT_NAMES = [
    'agent-editor',
    'automation-canvas',
    'meeting-detail',
    'notebook',
    'shield-redaction',
    'chat',
    'knowledge-base',
    'integrations',
];

const SCREENSHOT_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

/**
 * Which screenshots are present on disk right now.
 * @returns {Map<string, {key: string, file: string, contentType: string}>}
 */
function resolveScreenshots(dir = SCREENSHOT_DIR) {
    const found = new Map();
    for (const name of SCREENSHOT_NAMES) {
        for (const ext of SCREENSHOT_EXTS) {
            const file = path.join(dir, `${name}${ext}`);
            if (!fs.existsSync(file)) continue;
            found.set(name, {
                key: `cms/beeflow-${name}${ext}`,
                file,
                contentType: ext === '.png' ? 'image/png'
                    : ext === '.webp' ? 'image/webp'
                        : 'image/jpeg',
            });
            break;
        }
    }
    return found;
}

/**
 * The asset key for a screenshot, or '' when it has not been supplied.
 *
 * Resolved at module load: the content module is a value, and the seeder
 * runs in the same process, so a file added between the two would be a
 * surprise either way. Re-running the seeder picks up new files.
 */
const PRESENT = resolveScreenshots();
function shot(name) {
    return PRESENT.get(name)?.key || '';
}

const KEYS = Object.freeze({
    logo: 'cms/beeflow-logo.svg',
    favicon: 'cms/beeflow-favicon.svg',
    architecture: 'cms/beeflow-architecture.svg',
    privacyFlow: 'cms/beeflow-privacy-flow.svg',
    knowledgeFlow: 'cms/beeflow-knowledge-flow.svg',
    hive: 'cms/beeflow-hive.svg',
});

// ── Social cards (og:image) ──────────────────────────────────────────
//
// 1200×630 PNGs, because social scrapers render no SVG previews — every
// shared link used to show an empty card. Rendered by scripts/
// renderOgImages.js from ./ogCards.js and COMMITTED under ./og/, so the
// seeder only reads bytes. Unlike the screenshots these are not optional:
// every page's `seo.ogImage` points at one, and the seed test fails if a
// file is missing rather than shipping pages with broken previews.

const { OG_CARDS } = require('./ogCards');

const OG_DIR = path.join(__dirname, 'og');

const OG_KEYS = Object.freeze(Object.fromEntries(
    Object.entries(OG_CARDS).map(([name, card]) => [name, `cms/${card.file}`]),
));

/** The storage key for a social card. Unknown names throw at module load. */
function og(name) {
    const key = OG_KEYS[name];
    if (!key) throw new Error(`Unknown og card in seed content: ${name}`);
    return key;
}

/** Every card with its on-disk path — the seeder and the tests both use this. */
function resolveOgImages(dir = OG_DIR) {
    return Object.entries(OG_CARDS).map(([name, card]) => ({
        name,
        key: `cms/${card.file}`,
        file: path.join(dir, card.file),
    }));
}

module.exports = {
    ASSETS, KEYS,
    shot, resolveScreenshots,
    SCREENSHOT_DIR, SCREENSHOT_NAMES,
    og, OG_KEYS, resolveOgImages, OG_DIR,
};

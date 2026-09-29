/**
 * Render the marketing site's og:image cards to PNG.
 *
 * Run from server/ on a workstation (needs real fonts installed — the
 * container images deliberately do not rasterise text):
 *   node scripts/renderOgImages.js
 *
 * Writes 1200×630 PNGs into scripts/content/og/, which are committed and
 * uploaded by seedBeeflowSite.js exactly like the hand-drawn SVGs. Social
 * scrapers (LinkedIn, X, Slack, WhatsApp) render no SVG previews, which is
 * the entire reason these exist — see scripts/content/ogCards.js.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { OG_CARDS, buildOgCardSvg } = require('./content/ogCards');

const OUT_DIR = path.join(__dirname, 'content', 'og');

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const [name, card] of Object.entries(OG_CARDS)) {
        const svg = buildOgCardSvg(card);
        const out = path.join(OUT_DIR, card.file);
        const png = await sharp(Buffer.from(svg), { density: 96 })
            .resize(1200, 630)
            .png({ compressionLevel: 9 })
            .toBuffer();
        fs.writeFileSync(out, png);
        console.log(`[og] ${name} → ${card.file} (${(png.length / 1024).toFixed(0)} KB)`);
    }
}

main().catch((err) => {
    console.error('[og] failed:', err);
    process.exit(1);
});

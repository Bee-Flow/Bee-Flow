/**
 * Seed the real Bee Flow marketing website into this install's CMS.
 *
 * The content lives in ./content/beeflowSite.js as a v2 export bundle, so
 * seeding is the ordinary import path — the same code an operator hits when
 * they upload a .zip. That is deliberate: creating the site is also an
 * end-to-end test of export/import, and the result is byte-comparable with a
 * later export of the same site.
 *
 * The script is additive and never destructive:
 *   • it creates a NEW site every run (import always mints a fresh siteId)
 *   • it publishes that site so a preview is available
 *   • it does NOT touch cms_live_site_id — whatever is live stays live
 * Flip the new site live yourself from the builder's site menu once you have
 * looked at it.
 *
 * Assets go through the same sanitize-then-store path as an admin upload, so
 * the SVGs are served inline rather than force-downloaded.
 *
 * Run (inside the server container — Postgres has no host port):
 *   docker exec beeflow-server node //app/scripts/seedBeeflowSite.js
 * Or locally, with the server's DB env available:
 *   cd server && node scripts/seedBeeflowSite.js
 *
 * Flags:
 *   --name "…"   override the site name (default "Bee Flow")
 *   --live       also point the public site at the new one (opt-in, and it
 *                takes whatever is currently live offline)
 */

const fs = require('fs');
const path = require('path');

async function main() {
    const args = process.argv.slice(2);
    const nameIdx = args.indexOf('--name');
    const name = nameIdx >= 0 ? args[nameIdx + 1] : 'Bee Flow';
    const goLive = args.includes('--live');

    // Required late so a --help style run doesn't open a DB pool for nothing.
    const cmsStore = require(path.join(__dirname, '..', 'stores', 'cmsStore'));
    const storageStore = require(path.join(__dirname, '..', 'stores', 'storageStore'));
    const bundleLib = require(path.join(__dirname, '..', 'core', 'cmsExportBundle'));
    const { buildBundle } = require('./content/beeflowSite');
    const { ASSETS, resolveScreenshots, SCREENSHOT_NAMES, resolveOgImages } = require('./content/beeflowAssets');

    console.log('[seed] building bundle…');
    const bundle = buildBundle({ name });
    const pageCount = bundle.site.pages.length;
    const blockCount = bundle.site.pages.reduce((n, p) => n + p.blocks.length, 0);
    console.log(`[seed] ${pageCount} pages, ${blockCount} blocks`);

    // ── Assets ──
    // storageStore.init() is normally called during server boot; a script has
    // to do it itself or every upload lands in the local-disk fallback (or
    // throws). A failure here is not fatal: the site still imports, the media
    // slots just render their empty-state skeletons.
    let assetResult = { written: 0, reused: 0, failed: [] };
    try {
        if (typeof storageStore.init === 'function') await storageStore.init();

        // Hand-drawn SVGs, which live in the repo as strings.
        const assets = Object.entries(ASSETS).map(([key, svg]) => ({
            key,
            buffer: Buffer.from(svg, 'utf8'),
            contentType: 'image/svg+xml',
        }));

        // Product screenshots, which do not: the operator drops them into
        // scripts/content/screenshots/ (see the plan). Every one is optional
        // — the content module asks for a key via shot(), which returns ''
        // for anything absent, and the renderer then lays the block out
        // text-only. So a missing file is a quieter page, never a broken one.
        const shots = resolveScreenshots();
        for (const [name, meta] of shots) {
            assets.push({
                key: meta.key,
                buffer: fs.readFileSync(meta.file),
                contentType: meta.contentType,
            });
            console.log(`[seed] screenshot: ${name} → ${meta.key}`);
        }
        const absent = SCREENSHOT_NAMES.filter(n => !shots.has(n));
        if (absent.length) {
            console.log(`[seed] no screenshot for: ${absent.join(', ')} — those blocks render text-only`);
        }

        // Social cards (og:image). Committed PNGs, not optional: every page
        // references one, so a missing file here is a broken link preview.
        for (const img of resolveOgImages()) {
            assets.push({
                key: img.key,
                buffer: fs.readFileSync(img.file),
                contentType: 'image/png',
            });
        }

        // overwrite: the seed IS the source of truth for these keys. They are
        // generated from beeflowAssets.js and the keys never change, so without
        // this an edited logo or hero graphic would never reach storage — the
        // seeder would report success and keep serving the previous bytes.
        assetResult = await bundleLib.restoreAssets(assets, { overwrite: true });
        console.log(`[seed] assets: ${assetResult.written} written, ${assetResult.reused} already present`);
        for (const f of assetResult.failed) console.warn(`[seed] asset failed: ${f}`);
    } catch (err) {
        console.warn(`[seed] storage unavailable (${err.message}) — importing without artwork`);
    }

    // ── Site ──
    console.log('[seed] importing…');
    const result = await cmsStore.importSite(bundle);
    for (const w of result.warnings || []) console.warn(`[seed] warning: ${w}`);
    if (result.dropped > 0) {
        // Unknown block types are dropped silently by the store; a seed that
        // loses blocks must not look like a success.
        console.error(`[seed] ${result.dropped} block(s) were DROPPED as unknown types — check the block catalogue`);
    }

    // importSite suffixes the name so a restore is distinguishable from the
    // original. For a seed there is no original to confuse it with, and
    // "Bee Flow (imported)" would end up in the site switcher forever.
    await cmsStore.renameProject(result.siteId, name);

    await cmsStore.publishSite(result.siteId);

    if (goLive) {
        const { setLiveSiteId } = require(path.join(__dirname, '..', 'routes', 'cmsShared'));
        await setLiveSiteId(result.siteId);
        console.log('[seed] this site is now LIVE');
    }

    console.log('');
    console.log(`  siteId    ${result.siteId}`);
    console.log(`  name      ${name}`);
    console.log(`  pages     ${pageCount}`);
    console.log(`  published yes`);
    console.log(`  live      ${goLive ? 'yes' : 'no — flip it in the builder\'s site menu'}`);
    console.log('');

    return result.dropped > 0 ? 1 : 0;
}

// Requiring the store opens a pg pool that keeps the event loop alive, so an
// explicit exit is required or the script hangs after printing its summary.
main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error('[seed] failed:', err);
        process.exit(1);
    });

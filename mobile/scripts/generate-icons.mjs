/**
 * Generate the Android launcher / splash / notification icons from the one
 * brand asset that already lives in this repo.
 *
 * Source of truth: agent-hub/public/app-icon.svg. That file is an Inkscape
 * wrapper around a single embedded base64 PNG (1218×1376, RGBA) — the SVG has
 * no vector paths of its own, so there is nothing to lose by pulling the raster
 * straight out of it, and doing so avoids adding an SVG rasteriser to the
 * toolchain.
 *
 * The wrinkle this script exists to solve: the Bee Flow mark is BLACK (#080808)
 * with honey-gold (#f8b818) accents. Dropped unchanged onto the app's near-black
 * background (#0f0f13, --bg-primary) the black two-thirds of the logo simply
 * disappears. So for every surface that sits on a dark ground we emit a
 * "knockout" variant: black ink is recoloured to the theme's --text-primary
 * (#f8fafc) while the gold is left exactly as the brand intends.
 *
 * Outputs (all committed — CI must not need sharp to build an APK):
 *   assets/icon.png                      1024²  full-bleed, dark ground
 *   assets/adaptive-icon.png             1024²  foreground layer, transparent
 *   assets/adaptive-icon-monochrome.png  1024²  white silhouette (themed icons)
 *   assets/splash-icon.png                512²  knockout mark, transparent
 *   assets/notification-icon.png           96²  white silhouette, transparent
 *
 * Run: cd mobile && npx --yes sharp-cli@- >/dev/null 2>&1 ; node scripts/generate-icons.mjs
 * (sharp is intentionally NOT a dependency of this package — install it ad hoc
 * when you actually need to regenerate: `npm i --no-save sharp`.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOBILE = path.resolve(HERE, '..');
const ASSETS = path.join(MOBILE, 'assets');
const SVG = path.resolve(MOBILE, '../agent-hub/public/app-icon.svg');

/** Theme tokens this script bakes in. Keep in step with src/theme/tokens.ts. */
const BG_PRIMARY = { r: 0x0f, g: 0x0f, b: 0x13 };
const TEXT_PRIMARY = { r: 0xf8, g: 0xfa, b: 0xfc };

let sharp;
try {
    sharp = (await import('sharp')).default;
} catch {
    console.error(
        'sharp is not installed. It is deliberately not a dependency — run:\n' +
            '  cd mobile && npm i --no-save sharp && node scripts/generate-icons.mjs',
    );
    process.exit(1);
}

/**
 * Pull the embedded PNG out of the Inkscape SVG.
 *
 * Inkscape writes the base64 payload with literal `&#10;` entities rather than
 * raw newlines, so stripping only whitespace leaves the entities in the string
 * and Buffer.from silently truncates at the first bad character — which decodes
 * to a PNG with a valid header and a missing IEND. Strip the entities first.
 */
function extractEmbeddedPng() {
    const svg = fs.readFileSync(SVG, 'utf8');
    const marker = 'data:image/png;base64,';
    const at = svg.indexOf(marker);
    if (at === -1) throw new Error(`no embedded PNG found in ${SVG}`);
    const start = at + marker.length;
    const end = svg.indexOf('"', start);
    const b64 = svg.slice(start, end).replace(/&#10;/g, '').replace(/\s+/g, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.subarray(buf.length - 8).toString('latin1').indexOf('IEND') === -1) {
        throw new Error('extracted PNG is truncated (no IEND chunk)');
    }
    return buf;
}

/**
 * Recolour dark ink to `ink`, leaving saturated pixels (the gold) alone.
 *
 * Threshold is on luminance, not on an exact colour match: the source has
 * anti-aliased edges running the whole way from #080808 to transparent, and a
 * strict match would leave a black halo around every stroke.
 */
async function knockout(input, ink) {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let o = 0; o < data.length; o += 4) {
        if (data[o + 3] === 0) continue;
        const [r, g, b] = [data[o], data[o + 1], data[o + 2]];
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        const sat = (Math.max(r, g, b) - Math.min(r, g, b)) / 255;
        // Gold is bright AND saturated; ink is neither. Anything in between is
        // an anti-aliased edge — blend it toward the ink by how dark it is.
        if (sat > 0.25 && lum > 0.35) continue;
        const t = 1 - Math.min(1, lum / 0.35);
        data[o] = Math.round(r + (ink.r - r) * t);
        data[o + 1] = Math.round(g + (ink.g - g) * t);
        data[o + 2] = Math.round(b + (ink.b - b) * t);
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toBuffer();
}

/** Flatten every visible pixel to one solid colour — for themed/status-bar icons. */
async function silhouette(input, colour) {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let o = 0; o < data.length; o += 4) {
        if (data[o + 3] === 0) continue;
        data[o] = colour.r;
        data[o + 1] = colour.g;
        data[o + 2] = colour.b;
    }
    return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
        .png()
        .toBuffer();
}

/**
 * Centre `logo` on a transparent (or filled) square of `size`, scaled so its
 * longest side covers `coverage` of the canvas.
 *
 * `coverage` is the lever that keeps an adaptive icon from being cropped: only
 * the middle 66% of an adaptive layer is guaranteed visible once a launcher
 * applies its own mask, so the foreground layer uses a much smaller coverage
 * than the legacy square icon does.
 */
async function compose(logo, { size, coverage, background = null }) {
    const trimmed = await sharp(logo).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
    const target = Math.round(size * coverage);
    const scale = target / Math.max(trimmed.info.width, trimmed.info.height);
    const w = Math.max(1, Math.round(trimmed.info.width * scale));
    const h = Math.max(1, Math.round(trimmed.info.height * scale));
    const resized = await sharp(trimmed.data).resize(w, h, { fit: 'fill' }).toBuffer();
    return sharp({
        create: {
            width: size,
            height: size,
            channels: 4,
            background: background ?? { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: resized, gravity: 'centre' }])
        .png({ compressionLevel: 9 })
        .toBuffer();
}

async function write(name, buf) {
    const out = path.join(ASSETS, name);
    fs.writeFileSync(out, buf);
    const { width, height } = await sharp(buf).metadata();
    console.log(`  ${name.padEnd(32)} ${width}×${height}  ${(buf.length / 1024).toFixed(1)} kB`);
}

async function main() {
    fs.mkdirSync(ASSETS, { recursive: true });
    const source = extractEmbeddedPng();
    const light = await knockout(source, TEXT_PRIMARY);
    const white = await silhouette(source, { r: 255, g: 255, b: 255 });

    console.log('Generating Android icons from agent-hub/public/app-icon.svg');

    // Legacy square launcher icon: full-bleed on the brand ground.
    await write(
        'icon.png',
        await compose(light, { size: 1024, coverage: 0.66, background: { ...BG_PRIMARY, alpha: 1 } }),
    );

    // Adaptive foreground: transparent, inside the 66% safe zone with room to
    // spare so the parallax on Pixel launchers never clips a wing.
    await write('adaptive-icon.png', await compose(light, { size: 1024, coverage: 0.56 }));

    // Themed (monochrome) icon: the launcher tints this itself, so ship it flat
    // white — any colour here is thrown away, but transparency is respected.
    await write('adaptive-icon-monochrome.png', await compose(white, { size: 1024, coverage: 0.5 }));

    // Splash: sits on backgroundColor #0f0f13 from app.config.ts.
    await write('splash-icon.png', await compose(light, { size: 512, coverage: 0.8 }));

    // Status-bar notification icon. Android silently renders this as a white
    // mask on API 21+, so anything but white-on-transparent is a lie.
    await write('notification-icon.png', await compose(white, { size: 96, coverage: 0.85 }));
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

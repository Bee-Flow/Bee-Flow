/**
 * Turn a 3D CAD file into a picture — one PNG holding four labelled views.
 *
 * WHY A PICTURE AND NOT A 3D SCENE. Two callers need this and both want
 * pixels: the file preview (which already renders image/png and needed no new
 * component) and the vision model (which reads images and cannot read B-rep).
 * A GLB plus a browser viewer would serve only the first of those and would put
 * a renderer in the frontend bundle; a rendered sheet serves both, caches as an
 * ordinary derived file, and costs one image instead of four.
 *
 * WHY FOUR VIEWS IN ONE IMAGE. A single isometric hides exactly what these
 * drawings are about — a hole you cannot see is a hole you cannot count. Front,
 * top and right catch through-holes and counterbores from the directions a
 * draughtsman would have dimensioned them, and keeping them in ONE image means
 * the model reasons about one part rather than four unrelated pictures.
 *
 * SHADING IS FLAT, ON PURPOSE. Smoothed normals make a plate with holes look
 * like a pillow and blur the edge between a face and a fillet. Flat shading
 * from the face's own geometric normal keeps every planar face one solid tone,
 * which is what makes the holes read as holes.
 *
 * occt-import-js is OpenCascade compiled to WASM (LGPL-2.1). It is loaded at
 * run time as an unmodified, separately distributed artifact — nothing here
 * links it statically or alters it.
 */

'use strict';

const { createCanvas } = require('@napi-rs/canvas');

// Bounds. A CAD file is attacker-supplied in exactly the same sense a mailed
// attachment is, and the tesselator is a C++ kernel behind a WASM boundary:
// the cheapest safety is to refuse the sizes that make it expensive.
const LIMITS = Object.freeze({
    MAX_BYTES: 32 * 1024 * 1024,
    // Past this the picture stops improving and only the clock moves. A plate
    // tesselates to a few thousand triangles; a million means an assembly
    // nobody is going to read off a 1200px sheet anyway.
    MAX_TRIANGLES: 1_200_000,
    // Per view, in pixels. Sized for the ENLARGED view, not the thumbnail:
    // the thumbnail scales a big sheet down cheaply, while a small sheet
    // enlarged is just blur — and the whole reason to open one is to count
    // holes you could not see in the table. 760 puts a 12 mm plate's M5 tap on
    // roughly five pixels, which is the point where it reads as a circle.
    TILE: 760,
    PADDING: 16,
    LABEL_H: 26,
});

// The four viewpoints, as (forward, up) pairs in the part's own coordinates.
// `forward` points FROM the camera INTO the scene, so a larger projected depth
// is farther away — that is the convention the z-buffer below assumes.
//
// Z-up is the near-universal convention for the STEP files this reads, so
// "top" looks down -Z and "front" looks along +Y.
const VIEWS = Object.freeze([
    { key: 'iso', label: 'isometrisch', forward: [-1, 1, -1], up: [0, 0, 1] },
    { key: 'front', label: 'voor', forward: [0, 1, 0], up: [0, 0, 1] },
    { key: 'top', label: 'boven', forward: [0, 0, -1], up: [0, 1, 0] },
    { key: 'right', label: 'rechts', forward: [-1, 0, 0], up: [0, 0, 1] },
]);

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function norm(a) {
    const l = Math.hypot(a[0], a[1], a[2]);
    return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/**
 * Flatten every mesh the kernel returned into one triangle soup.
 *
 * Meshes are kept SEPARATE by the importer (one per B-rep solid/face group),
 * but a picture of an assembly wants them in one space — and the bounding box
 * has to span all of them or the views frame the first body and clip the rest.
 */
function collectTriangles(meshes) {
    const tris = [];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let dropped = 0;

    for (const mesh of meshes || []) {
        const pos = mesh?.attributes?.position?.array;
        const idx = mesh?.index?.array;
        if (!pos || !idx) continue;
        for (let i = 0; i + 2 < idx.length; i += 3) {
            if (tris.length >= LIMITS.MAX_TRIANGLES) { dropped++; continue; }
            const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
            const va = [pos[a], pos[a + 1], pos[a + 2]];
            const vb = [pos[b], pos[b + 1], pos[b + 2]];
            const vc = [pos[c], pos[c + 1], pos[c + 2]];
            if (!Number.isFinite(va[0]) || !Number.isFinite(vb[0]) || !Number.isFinite(vc[0])) continue;
            tris.push([va, vb, vc]);
            for (const v of [va, vb, vc]) {
                for (let k = 0; k < 3; k++) {
                    if (v[k] < min[k]) min[k] = v[k];
                    if (v[k] > max[k]) max[k] = v[k];
                }
            }
        }
    }
    return { tris, min, max, dropped };
}

/**
 * Rasterise one view into an RGBA buffer with a z-buffer.
 *
 * A painter's-algorithm sort would have been fewer lines, but it is wrong
 * exactly where these parts are interesting: two faces meeting at a hole are
 * at the same average depth and flicker over each other. Per-pixel depth is
 * the only version that always tells the truth.
 */
function renderView(tris, center, radius, view, size) {
    const f = norm(view.forward);
    // Guard the degenerate case where `up` is parallel to the view direction.
    let upRef = view.up;
    if (Math.abs(dot(f, norm(upRef))) > 0.999) upRef = [1, 0, 0];
    const r = norm(cross(f, upRef));
    const u = norm(cross(r, f));

    const rgba = new Uint8ClampedArray(size * size * 4);
    const depth = new Float32Array(size * size).fill(Infinity);
    // Paper-white ground: the same surface a drawing is printed on, and the
    // highest contrast against the part.
    rgba.fill(255);

    // Orthographic fit: the part's bounding sphere maps to the tile, so every
    // view is at the SAME scale. Comparing the front and top of a part whose
    // views were each independently zoomed is how you misjudge a thickness.
    const usable = size - LIMITS.PADDING * 2;
    const scale = radius > 1e-9 ? usable / (radius * 2) : 1;
    const cx = size / 2;
    const cy = size / 2;

    const project = (v) => {
        const d = sub(v, center);
        return [cx + dot(d, r) * scale, cy - dot(d, u) * scale, dot(d, f)];
    };

    for (const [va, vb, vc] of tris) {
        const pa = project(va); const pb = project(vb); const pc = project(vc);

        // Screen-space winding gives both the backface test and the area term.
        const area = (pb[0] - pa[0]) * (pc[1] - pa[1]) - (pc[0] - pa[0]) * (pb[1] - pa[1]);
        if (area === 0) continue;

        // Flat shade from the FACE normal, lit from over the viewer's shoulder
        // and slightly to one side — a light exactly on the view axis flattens
        // every surface that faces you into the same tone.
        const n = norm(cross(sub(vb, va), sub(vc, va)));
        const lightDir = norm([f[0] * -1 + r[0] * 0.45 + u[0] * 0.35, f[1] * -1 + r[1] * 0.45 + u[1] * 0.35, f[2] * -1 + r[2] * 0.45 + u[2] * 0.35]);
        const lambert = Math.abs(dot(n, lightDir));
        const shade = 0.30 + 0.62 * lambert;
        const rr = Math.round(150 * shade + 28);
        const gg = Math.round(163 * shade + 30);
        const bb = Math.round(184 * shade + 34);

        const minX = Math.max(0, Math.floor(Math.min(pa[0], pb[0], pc[0])));
        const maxX = Math.min(size - 1, Math.ceil(Math.max(pa[0], pb[0], pc[0])));
        const minY = Math.max(0, Math.floor(Math.min(pa[1], pb[1], pc[1])));
        const maxY = Math.min(size - 1, Math.ceil(Math.max(pa[1], pb[1], pc[1])));
        if (minX > maxX || minY > maxY) continue;

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const px = x + 0.5; const py = y + 0.5;
                let w0 = ((pb[0] - pa[0]) * (py - pa[1]) - (px - pa[0]) * (pb[1] - pa[1])) / area;
                let w1 = ((pc[0] - pb[0]) * (py - pb[1]) - (px - pb[0]) * (pc[1] - pb[1])) / area;
                let w2 = ((pa[0] - pc[0]) * (py - pc[1]) - (px - pc[0]) * (pa[1] - pc[1])) / area;
                // Barycentrics from a negatively-wound triangle come out
                // negative together; flip rather than cull, so a part whose
                // faces are wound inconsistently still renders solid.
                if (w0 < 0 || w1 < 0 || w2 < 0) {
                    if (w0 > 0 || w1 > 0 || w2 > 0) continue;
                    w0 = -w0; w1 = -w1; w2 = -w2;
                }
                const z = pa[2] * w1 + pb[2] * w2 + pc[2] * w0;
                const o = y * size + x;
                if (z >= depth[o]) continue;
                depth[o] = z;
                const p = o * 4;
                rgba[p] = rr; rgba[p + 1] = gg; rgba[p + 2] = bb; rgba[p + 3] = 255;
            }
        }
    }
    return { rgba, depth };
}

/**
 * Outline where the depth jumps.
 *
 * Shading alone leaves a through-hole seen face-on as a slightly darker disc
 * that a reader — human or model — can miss entirely. A dark line wherever
 * neighbouring pixels sit far apart in depth turns every hole, step and
 * silhouette into an edge, which is how a technical drawing communicates.
 */
function drawDepthEdges(rgba, depth, size, radius) {
    // Scaled to the part, so the same threshold works for a 20 mm bracket and
    // a 963 mm strip.
    const jump = Math.max(radius * 0.02, 1e-6);
    const out = Uint8ClampedArray.from(rgba);
    for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
            const o = y * size + x;
            const d = depth[o];
            if (d === Infinity) continue;
            const n1 = depth[o - 1]; const n2 = depth[o + 1];
            const n3 = depth[o - size]; const n4 = depth[o + size];
            const edge = [n1, n2, n3, n4].some((nd) => nd === Infinity || Math.abs(nd - d) > jump);
            if (!edge) continue;
            const p = o * 4;
            out[p] = 40; out[p + 1] = 48; out[p + 2] = 60; out[p + 3] = 255;
        }
    }
    return out;
}

/**
 * Render a STEP/IGES buffer to one labelled PNG sheet.
 * @returns {Promise<{png: Buffer, stats: object}>}
 */
async function renderCadSheet(buffer, { format = 'step' } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('cadRender: empty buffer');
    if (buffer.length > LIMITS.MAX_BYTES) {
        throw new Error(`cadRender: file is ${Math.round(buffer.length / 1048576)} MB, over the ${LIMITS.MAX_BYTES / 1048576} MB limit`);
    }

    // Required lazily: the WASM binary is ~11 MB and most requests to this
    // process will never touch a CAD file.
    const occtimportjs = require('occt-import-js');
    const occt = await occtimportjs();
    const bytes = new Uint8Array(buffer);
    const read = format === 'iges' ? occt.ReadIgesFile(bytes, null) : occt.ReadStepFile(bytes, null);
    if (!read || !read.success) throw new Error('cadRender: the CAD kernel could not read this file');

    const { tris, min, max, dropped } = collectTriangles(read.meshes);
    if (!tris.length) throw new Error('cadRender: the file contains no solid geometry to draw');

    const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
    const radius = Math.max(Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2, 1e-6);

    const tile = LIMITS.TILE;
    const canvas = createCanvas(tile * 2, (tile + LIMITS.LABEL_H) * 2);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let i = 0; i < VIEWS.length; i++) {
        const view = VIEWS[i];
        const { rgba, depth } = renderView(tris, center, radius, view, tile);
        const outlined = drawDepthEdges(rgba, depth, tile, radius);

        const ox = (i % 2) * tile;
        const oy = Math.floor(i / 2) * (tile + LIMITS.LABEL_H);

        const img = ctx.createImageData(tile, tile);
        img.data.set(outlined);
        ctx.putImageData(img, ox, oy);

        // The label is not decoration: without it a model asked "how many holes
        // go through" cannot tell which picture is the one looking down the hole.
        ctx.fillStyle = '#1f2937';
        ctx.font = '17px sans-serif';
        ctx.fillText(view.label, ox + LIMITS.PADDING, oy + tile + 18);
        ctx.strokeStyle = '#d1d5db';
        ctx.strokeRect(ox + 0.5, oy + 0.5, tile - 1, tile + LIMITS.LABEL_H - 1);
    }

    const png = await canvas.encode('png');
    return {
        png,
        stats: {
            meshes: read.meshes.length,
            triangles: tris.length,
            truncated: dropped > 0,
            sizeMm: [max[0] - min[0], max[1] - min[1], max[2] - min[2]].map((v) => Math.round(v * 100) / 100),
        },
    };
}

module.exports = { renderCadSheet, LIMITS, _internal: { collectTriangles, renderView, VIEWS } };

/**
 * Draw an ASCII DXF — the flat cutting geometry, as one picture.
 *
 * WHY A SEPARATE RENDERER FROM cadRender.js. That one runs a B-rep kernel
 * (occt-import-js) over solids and shades four camera views. A DXF is not a
 * solid: it is a list of 2D curves in a plane, which is exactly what a laser or
 * waterjet cuts. There is nothing to tesselate and nothing to shade, and the
 * kernel refuses the file outright — so a .DXF had no preview at all and landed
 * in the files pane as a download button, next to .step files that showed a
 * drawing. Same job, two formats, and only one of them was answered.
 *
 * WHAT IS DRAWN. The entity types a nesting/CAM exporter actually writes:
 * LINE, LWPOLYLINE and old-style POLYLINE (bulges flattened to arcs), CIRCLE,
 * ARC, ELLIPSE, POINT, SPLINE (through its fit points, or its control polygon
 * when it has none), and INSERT — block references, which is how most of those
 * exporters wrap a part, so skipping them would render a great many files
 * blank. Text and dimensions are deliberately NOT drawn: this is a picture of
 * what gets cut, and annotation at thumbnail scale is noise.
 *
 * WHAT IS NOT. Binary DXF and DWG carry no group codes to walk; they are
 * refused by the caller, which is honest about it rather than showing an empty
 * sheet. Layers, colours and line types are ignored — every contour is drawn
 * the same, because "which layer" is not a question a preview answers.
 *
 * The result is an ordinary PNG, so it rides the exact same route, cache and
 * preview component the 3D sheet already uses.
 */

'use strict';

const { createCanvas } = require('@napi-rs/canvas');
const { INSUNITS_TO_MM } = require('./cadMetadata');

// Bounds. A DXF is attacker-supplied in the same sense a mailed attachment is,
// and every one of these caps turns an expensive file into a truncated picture
// rather than a stalled request.
const LIMITS = Object.freeze({
    MAX_BYTES: 32 * 1024 * 1024,
    MAX_ENTITIES: 200_000,
    // Flattened line segments. A part is a few thousand; a hundred thousand is
    // a map of a city that nobody is going to read off a 1200px sheet.
    MAX_SEGMENTS: 300_000,
    // Segments per full circle at the largest curvature — enough that a Ø5 tap
    // hole still reads as a circle, few enough that a drawing full of them
    // stays inside MAX_SEGMENTS.
    ARC_STEPS: 64,
    WIDTH: 1200,
    HEIGHT: 900,
    // Floors for the aspect-fitted sheet: the caption has to fit across the
    // bottom, and a tall narrow part must not become a sliver.
    MIN_DRAW_W: 560,
    MIN_DRAW_H: 220,
    PADDING: 24,
    CAPTION_H: 34,
    // How deep an INSERT may reference another block. Real parts nest one or
    // two levels; the cap is what stops a block that references itself.
    MAX_BLOCK_DEPTH: 6,
});

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
// CR LF SUB NUL, spelled out: the sentinel the DXF spec puts at the head
// of a BINARY dxf. Built from char codes so no layer between here and the
// file can reinterpret an escape.
const DXF_BINARY_SENTINEL = 'AutoCAD Binary DXF' + String.fromCharCode(13, 10, 26, 0);

// ── Parsing ─────────────────────────────────────────────────────────
//
// A DXF is strictly (group-code line, value line) pairs. Every entity is
// therefore an ORDERED list of pairs, and the order matters: an LWPOLYLINE's
// vertices are just repeated 10/20 codes, and a bulge (42) belongs to the
// vertex it follows. So entities keep their pair list rather than a map, and
// each type reads what it needs out of it.

/** Split the file into ENTITIES, the BLOCKS table, and the header bits we use. */
function parseDxf(text) {
    const lines = text.split(/\r\n|\n/);
    const entities = [];
    const blocks = new Map();
    const header = { insunits: null };

    let section = null;
    let pendingSection = false;
    let headerVar = null;
    let current = null;          // the entity being collected
    let sink = entities;         // where finished entities go (swapped inside BLOCKS)
    let block = null;            // the BLOCK being collected
    let count = 0;
    let truncated = false;

    const closeEntity = () => {
        // A BLOCK is a HEADER, not a thing to draw: its name and base point are
        // read inline below and the entities that follow it are the drawing.
        // Filed as one, it sat at the head of every block's own entity list.
        if (current && sink && current.type !== 'BLOCK') sink.push(current);
        current = null;
    };

    for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = lines[i].trim();
        const value = (lines[i + 1] ?? '').trim();

        if (code === '0') {
            closeEntity();
            headerVar = null;
            if (value === 'SECTION') { pendingSection = true; section = null; continue; }
            if (value === 'ENDSEC') { section = null; sink = entities; continue; }
            if (value === 'EOF') break;

            if (section === 'BLOCKS') {
                if (value === 'BLOCK') { block = { name: null, base: [0, 0], entities: [] }; sink = block.entities; current = { type: 'BLOCK', pairs: [] }; continue; }
                if (value === 'ENDBLK') {
                    if (block && block.name) blocks.set(block.name, block);
                    block = null; sink = null; continue;
                }
            }
            if (section !== 'ENTITIES' && section !== 'BLOCKS') continue;
            if (count >= LIMITS.MAX_ENTITIES) { truncated = true; continue; }
            count += 1;
            current = { type: value, pairs: [] };
            continue;
        }

        if (pendingSection && code === '2') { section = value; pendingSection = false; continue; }

        if (section === 'HEADER') {
            if (code === '9') { headerVar = value; continue; }
            if (headerVar === '$INSUNITS' && code === '70') header.insunits = parseInt(value, 10);
            continue;
        }

        if (!current) continue;
        // A BLOCK's own header pairs name it and give its base point; the
        // entities that follow are drawn relative to that point.
        if (current.type === 'BLOCK' && block) {
            if (code === '2' && !block.name) block.name = value;
            else if (code === '10') block.base[0] = num(value);
            else if (code === '20') block.base[1] = num(value);
            continue;
        }
        current.pairs.push([code, value]);
    }
    closeEntity();
    return { entities, blocks, header, truncated };
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

/** First value for a group code, or a fallback. */
function pick(pairs, code, fallback = null) {
    for (const [c, v] of pairs) if (c === code) return num(v);
    return fallback;
}

/** First STRING value for a group code. */
function pickStr(pairs, code) {
    for (const [c, v] of pairs) if (c === code) return v;
    return null;
}

// ── Curve flattening ────────────────────────────────────────────────

/** Points along an arc, inclusive of both ends. */
function arcPoints(cx, cy, r, a0, a1, out) {
    let sweep = a1 - a0;
    while (sweep <= 0) sweep += TAU;
    const steps = Math.max(2, Math.ceil((sweep / TAU) * LIMITS.ARC_STEPS));
    for (let i = 0; i <= steps; i += 1) {
        const a = a0 + (sweep * i) / steps;
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
}

/**
 * A polyline segment with a BULGE is a circular arc, not a straight line —
 * which is how a rounded slot or a filleted corner is stored. bulge = tan(θ/4)
 * where θ is the included angle; a rounded part drawn as straight chords looks
 * like a stop sign, so this is not cosmetic.
 */
function bulgeArc(p0, p1, bulge, out) {
    const theta = 4 * Math.atan(bulge);
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const chord = Math.hypot(dx, dy);
    if (!chord || !Number.isFinite(theta) || Math.abs(theta) < 1e-9) { out.push(p1); return; }
    const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
    // Centre sits off the chord midpoint, on the side the bulge's sign chooses.
    const h = Math.sqrt(Math.max(0, r * r - (chord / 2) ** 2)) * (Math.abs(theta) > Math.PI ? -1 : 1);
    const sign = bulge > 0 ? 1 : -1;
    const mx = (p0[0] + p1[0]) / 2;
    const my = (p0[1] + p1[1]) / 2;
    const cx = mx - (sign * h * dy) / chord;
    const cy = my + (sign * h * dx) / chord;
    const a0 = Math.atan2(p0[1] - cy, p0[0] - cx);
    const a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
    const pts = [];
    // A negative bulge sweeps clockwise. arcPoints only ever walks CCW, so the
    // clockwise case is the same arc walked from the other end and reversed.
    if (sign > 0) arcPoints(cx, cy, r, a0, a1, pts);
    else { arcPoints(cx, cy, r, a1, a0, pts); pts.reverse(); }
    for (let i = 1; i < pts.length; i += 1) out.push(pts[i]);
}

// ── Entities → polylines ────────────────────────────────────────────

/** Apply an INSERT's scale/rotation/offset to a point. */
function transform(t, x, y) {
    if (!t) return [x, y];
    const sx = x * t.sx;
    const sy = y * t.sy;
    const c = Math.cos(t.rot);
    const s = Math.sin(t.rot);
    return [t.ox + sx * c - sy * s, t.oy + sx * s + sy * c];
}

function pushPath(paths, pts, t) {
    if (pts.length < 2) return;
    paths.push(t ? pts.map(([x, y]) => transform(t, x, y)) : pts);
}

/** Ordered (x, y) vertices of an LWPOLYLINE, with each vertex's bulge. */
function lwVertices(pairs) {
    const verts = [];
    let cur = null;
    for (const [code, raw] of pairs) {
        if (code === '10') { if (cur) verts.push(cur); cur = { x: num(raw), y: 0, bulge: 0 }; }
        else if (code === '20' && cur) cur.y = num(raw);
        else if (code === '42' && cur) cur.bulge = num(raw);
    }
    if (cur) verts.push(cur);
    return verts;
}

/** Straight/bulged vertex list → one flattened path. */
function vertexPath(verts, closed) {
    const pts = [];
    if (!verts.length) return pts;
    pts.push([verts[0].x, verts[0].y]);
    const last = closed ? verts.length : verts.length - 1;
    for (let i = 0; i < last; i += 1) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        if (a.bulge) bulgeArc([a.x, a.y], [b.x, b.y], a.bulge, pts);
        else pts.push([b.x, b.y]);
    }
    return pts;
}

/**
 * Walk a list of entities into flattened paths.
 *
 * `t` is the transform an enclosing INSERT imposed; `depth` bounds block
 * recursion. Old-style POLYLINE keeps its vertices in the SEPARATE entities
 * that follow it up to SEQEND, so the walk carries a small piece of state for
 * exactly that case — the only entity in the format that spans siblings.
 */
function collectPaths(entities, blocks, paths, t, depth, budget) {
    let poly = null;   // { verts, closed } while inside a POLYLINE…SEQEND run

    for (const ent of entities) {
        if (budget.segments > LIMITS.MAX_SEGMENTS) { budget.truncated = true; return; }
        const p = ent.pairs;

        if (poly && ent.type === 'VERTEX') {
            poly.verts.push({ x: pick(p, '10', 0), y: pick(p, '20', 0), bulge: pick(p, '42', 0) });
            continue;
        }
        if (poly && ent.type === 'SEQEND') {
            const pts = vertexPath(poly.verts, poly.closed);
            budget.segments += pts.length;
            pushPath(paths, pts, t);
            poly = null;
            continue;
        }
        if (poly) { poly = null; } // an unterminated POLYLINE ends where the next entity starts

        switch (ent.type) {
            case 'LINE': {
                const pts = [[pick(p, '10', 0), pick(p, '20', 0)], [pick(p, '11', 0), pick(p, '21', 0)]];
                budget.segments += 1;
                pushPath(paths, pts, t);
                break;
            }
            case 'LWPOLYLINE': {
                const closed = (pick(p, '70', 0) & 1) === 1;
                const pts = vertexPath(lwVertices(p), closed);
                budget.segments += pts.length;
                pushPath(paths, pts, t);
                break;
            }
            case 'POLYLINE': {
                poly = { verts: [], closed: (pick(p, '70', 0) & 1) === 1 };
                break;
            }
            case 'CIRCLE': {
                const pts = [];
                arcPoints(pick(p, '10', 0), pick(p, '20', 0), Math.abs(pick(p, '40', 0)), 0, TAU, pts);
                budget.segments += pts.length;
                pushPath(paths, pts, t);
                break;
            }
            case 'ARC': {
                const pts = [];
                arcPoints(pick(p, '10', 0), pick(p, '20', 0), Math.abs(pick(p, '40', 0)),
                    pick(p, '50', 0) * DEG, pick(p, '51', 0) * DEG, pts);
                budget.segments += pts.length;
                pushPath(paths, pts, t);
                break;
            }
            case 'ELLIPSE': {
                const cx = pick(p, '10', 0);
                const cy = pick(p, '20', 0);
                const mx = pick(p, '11', 0);   // major axis endpoint, relative to the centre
                const my = pick(p, '21', 0);
                const ratio = pick(p, '40', 1);
                const a0 = pick(p, '41', 0);
                const a1 = pick(p, '42', TAU);
                const major = Math.hypot(mx, my);
                const rot = Math.atan2(my, mx);
                const pts = [];
                let sweep = a1 - a0;
                while (sweep <= 0) sweep += TAU;
                const steps = Math.max(2, Math.ceil((sweep / TAU) * LIMITS.ARC_STEPS));
                for (let i = 0; i <= steps; i += 1) {
                    const u = a0 + (sweep * i) / steps;
                    const ex = major * Math.cos(u);
                    const ey = major * ratio * Math.sin(u);
                    pts.push([cx + ex * Math.cos(rot) - ey * Math.sin(rot), cy + ex * Math.sin(rot) + ey * Math.cos(rot)]);
                }
                budget.segments += pts.length;
                pushPath(paths, pts, t);
                break;
            }
            case 'SPLINE': {
                // Fit points describe the curve the draughtsman drew; control
                // points only its hull. Prefer the former, fall back to the
                // latter — a hull is a rougher shape but still the right one.
                const fit = [];
                const ctrl = [];
                let cur = null;
                for (const [code, raw] of p) {
                    if (code === '11') { if (cur) fit.push(cur); cur = [num(raw), 0]; }
                    else if (code === '21' && cur) { cur[1] = num(raw); fit.push(cur); cur = null; }
                }
                let ctrlCur = null;
                for (const [code, raw] of p) {
                    if (code === '10') { if (ctrlCur) ctrl.push(ctrlCur); ctrlCur = [num(raw), 0]; }
                    else if (code === '20' && ctrlCur) { ctrlCur[1] = num(raw); ctrl.push(ctrlCur); ctrlCur = null; }
                }
                const pts = fit.length >= 2 ? fit : ctrl;
                budget.segments += pts.length;
                pushPath(paths, pts, t);
                break;
            }
            case 'POINT': {
                // A drilled centre mark. Drawn as a tiny cross so it survives
                // the scale-down instead of vanishing into one pixel.
                const x = pick(p, '10', 0);
                const y = pick(p, '20', 0);
                budget.segments += 2;
                pushPath(paths, [[x, y], [x, y]], t);
                break;
            }
            case 'INSERT': {
                if (depth >= LIMITS.MAX_BLOCK_DEPTH) break;
                const name = pickStr(p, '2');
                const block = name ? blocks.get(name) : null;
                if (!block) break;
                const rot = pick(p, '50', 0) * DEG;
                const sx = pick(p, '41', 1) || 1;
                const sy = pick(p, '42', 1) || 1;
                const base = block.base || [0, 0];
                // The block's own base point is its origin, so shift by it
                // before the enclosing transform is applied.
                const inner = {
                    ox: pick(p, '10', 0) - base[0] * sx,
                    oy: pick(p, '20', 0) - base[1] * sy,
                    sx, sy, rot,
                };
                const nested = [];
                collectPaths(block.entities, blocks, nested, inner, depth + 1, budget);
                for (const path of nested) pushPath(paths, path, t);
                break;
            }
            default:
                break; // TEXT, DIMENSION, HATCH… — not what gets cut
        }
    }
}

// ── Drawing ─────────────────────────────────────────────────────────

/** The caption: what a quoter wants to know before opening anything else. */
function captionFor(width, height, insunits, paths, truncated) {
    const unit = INSUNITS_TO_MM[insunits];
    const round = (v) => Math.round(v * 10) / 10;
    const size = unit
        ? `${round(width * unit.mm)} × ${round(height * unit.mm)} mm`
        : `${round(width)} × ${round(height)} eenheden`;
    // "elementen", not "contouren": one closed outline is often stored as a
    // dozen separate LINE and ARC entities, so calling the count contours
    // would tell a quoter there are twelve holes in a plate that has four.
    const parts = [size, `${paths.length} elementen`];
    if (truncated) parts.push('bijgesneden — het bestand is te groot om helemaal te tekenen');
    return parts.join(' · ');
}

/**
 * Render an ASCII DXF to a PNG.
 *
 * Throws — never returns a blank sheet — when there is nothing to draw. The
 * caller turns that into a 415 with the reason on it, which is a better answer
 * than a white rectangle the viewer has to interpret.
 */
async function renderDxfSheet(buffer, { name = '' } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('dxfRender: empty buffer');
    if (buffer.length > LIMITS.MAX_BYTES) {
        throw new Error(`dxfRender: file is ${Math.round(buffer.length / 1048576)} MB, over the ${LIMITS.MAX_BYTES / 1048576} MB limit`);
    }
    // A binary DXF has no group-code lines to walk. Said plainly here, because
    // the alternative is parsing it into zero entities and reporting "no
    // geometry" — true, and useless to whoever has to decide what to do next.
    if (buffer.subarray(0, DXF_BINARY_SENTINEL.length).toString('latin1') === DXF_BINARY_SENTINEL) {
        throw new Error('dxfRender: this is a binary DXF, which cannot be drawn — ask for an ASCII DXF');
    }

    const { entities, blocks, header, truncated: entTruncated } = parseDxf(buffer.toString('utf8'));
    const paths = [];
    const budget = { segments: 0, truncated: false };
    collectPaths(entities, blocks, paths, null, 0, budget);
    if (!paths.length) throw new Error('dxfRender: the file contains no geometry to draw');

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const path of paths) {
        for (const [x, y] of path) {
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) throw new Error('dxfRender: the geometry has no usable coordinates');

    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);

    // The SHEET takes the part's proportions rather than the part floating in
    // a fixed rectangle: a 2 m × 100 mm strip on a 4:3 page is a hairline in a
    // field of white, and the preview pane scales whatever it is given. Bounded
    // both ways — wide enough that the caption still fits, tall enough that a
    // narrow upright part is not a sliver.
    const aspect = spanX / spanY;
    let drawW = LIMITS.WIDTH - LIMITS.PADDING * 2;
    let drawH = LIMITS.HEIGHT - LIMITS.PADDING * 2 - LIMITS.CAPTION_H;
    if (drawW / drawH > aspect) drawW = Math.max(LIMITS.MIN_DRAW_W, Math.round(drawH * aspect));
    else drawH = Math.max(LIMITS.MIN_DRAW_H, Math.round(drawW / aspect));

    const canvas = createCanvas(drawW + LIMITS.PADDING * 2, drawH + LIMITS.PADDING * 2 + LIMITS.CAPTION_H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const scale = Math.min(drawW / spanX, drawH / spanY);
    // Centred in the drawing band, and Y FLIPPED: a DXF's Y grows upward, a
    // canvas's downward, so drawing it straight would mirror every part.
    const ox = LIMITS.PADDING + (drawW - spanX * scale) / 2;
    const oy = LIMITS.PADDING + (drawH - spanY * scale) / 2;
    const px = (x) => ox + (x - minX) * scale;
    const py = (y) => oy + (maxY - y) * scale;

    ctx.strokeStyle = '#111827';
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const path of paths) {
        ctx.beginPath();
        ctx.moveTo(px(path[0][0]), py(path[0][1]));
        for (let i = 1; i < path.length; i += 1) ctx.lineTo(px(path[i][0]), py(path[i][1]));
        ctx.stroke();
    }

    const caption = captionFor(spanX, spanY, header.insunits, paths, budget.truncated || entTruncated);
    ctx.fillStyle = '#1f2937';
    ctx.font = '18px sans-serif';
    ctx.fillText(caption, LIMITS.PADDING, canvas.height - LIMITS.PADDING);
    // The filename only when there is room for it beside the caption — a name
    // overprinting the size is worse than no name.
    if (name && canvas.width >= 900) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '15px sans-serif';
        const label = String(name).slice(0, 80);
        const room = canvas.width - LIMITS.PADDING * 2 - ctx.measureText(caption).width - 24;
        if (ctx.measureText(label).width <= room) {
            ctx.fillText(label, canvas.width - LIMITS.PADDING - ctx.measureText(label).width, canvas.height - LIMITS.PADDING);
        }
    }

    const png = await canvas.encode('png');
    return {
        png,
        stats: {
            paths: paths.length,
            segments: budget.segments,
            truncated: Boolean(budget.truncated || entTruncated),
            size: [Math.round(spanX * 100) / 100, Math.round(spanY * 100) / 100],
            insunits: header.insunits ?? null,
        },
    };
}

module.exports = { renderDxfSheet, LIMITS, _internal: { parseDxf, collectPaths, vertexPath, bulgeArc } };

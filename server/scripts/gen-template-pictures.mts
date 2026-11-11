#!/usr/bin/env node
/**
 * gen-template-pictures — the placeholder product pictures of the built-in Inbound orders
 * template (server/appStudio/templates/appInboundOrders.js), drawn from flat-colour shapes and
 * written as small PNG files next to it, in server/appStudio/templates/pictures/.
 *
 *   cd server && node scripts/gen-template-pictures.mts
 *
 * Original art made here, nothing downloaded: a few rectangles, circles and ellipses per picture
 * on a soft background, no anti-aliasing, so each file stays a few kilobytes. The PNG encoder is
 * the minimum (8-bit RGB, filter 0 per row, zlib from node:zlib). Run once; the files are committed
 * and read by the template at require time. Re-running writes the same bytes.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../appStudio/templates/pictures');
const W = 320;
const H = 240;

type Rgb = [number, number, number];
interface Shape { color: Rgb; hit: (px: number, py: number) => boolean }
interface Picture { background: string; shapes: Shape[] }

const hex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// Shapes: each answers whether a pixel is inside it.
const rect = (x: number, y: number, w: number, h: number, color: string): Shape => ({ color: hex(color), hit: (px, py) => px >= x && px < x + w && py >= y && py < y + h });
const circle = (cx: number, cy: number, r: number, color: string): Shape => ({ color: hex(color), hit: (px, py) => (px - cx) ** 2 + (py - cy) ** 2 <= r * r });
const ellipse = (cx: number, cy: number, rx: number, ry: number, color: string): Shape => ({ color: hex(color), hit: (px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1 });
const ring = (cx: number, cy: number, r: number, inner: number, color: string): Shape => ({ color: hex(color), hit: (px, py) => { const d = (px - cx) ** 2 + (py - cy) ** 2; return d <= r * r && d >= inner * inner; } });

/** A desk lamp: a round base, a stem, an arm and a shade with its light. */
const LAMP: Picture = {
    background: '#EEF2F7',
    shapes: [
        ellipse(160, 214, 110, 10, '#D9E0EA'),
        ellipse(120, 206, 46, 10, '#5B6573'),
        rect(116, 110, 8, 96, '#8A94A3'),
        rect(116, 104, 86, 8, '#8A94A3'),
        circle(120, 108, 9, '#5B6573'),
        ellipse(206, 140, 30, 12, '#FFE7A3'),
        rect(176, 92, 60, 34, '#F59E0B'),
        ellipse(206, 126, 30, 8, '#F59E0B'),
        rect(196, 84, 20, 10, '#5B6573'),
    ],
};

/** An oak side chair: back, seat and legs. */
const CHAIR: Picture = {
    background: '#F4EFE8',
    shapes: [
        ellipse(160, 216, 96, 9, '#E3DACD'),
        rect(110, 44, 14, 170, '#9A6B3F'),
        rect(196, 44, 14, 170, '#9A6B3F'),
        rect(110, 44, 100, 16, '#B07D4B'),
        rect(110, 74, 100, 10, '#B07D4B'),
        rect(100, 128, 132, 20, '#C08A55'),
        rect(212, 148, 12, 66, '#9A6B3F'),
        rect(104, 148, 12, 66, '#9A6B3F'),
    ],
};

/** A stoneware mug: body, glaze band and handle. */
const MUG: Picture = {
    background: '#EAF4F1',
    shapes: [
        ellipse(160, 206, 86, 9, '#D3E4DF'),
        ring(214, 132, 34, 20, '#2F7D6D'),
        rect(110, 76, 96, 126, '#3B9C88'),
        ellipse(158, 202, 48, 8, '#3B9C88'),
        ellipse(158, 76, 48, 10, '#2F7D6D'),
        ellipse(158, 76, 40, 7, '#1F5A4E'),
        rect(110, 100, 96, 14, '#F2E9D8'),
    ],
};

function pixels({ background, shapes }: Picture): Buffer {
    const bg = hex(background);
    const rows = Buffer.alloc((W * 3 + 1) * H);
    let at = 0;
    for (let y = 0; y < H; y += 1) {
        rows[at++] = 0; // filter: none
        for (let x = 0; x < W; x += 1) {
            let c = bg;
            for (const s of shapes) if (s.hit(x + 0.5, y + 0.5)) c = s.color;
            rows[at++] = c[0]; rows[at++] = c[1]; rows[at++] = c[2];
        }
    }
    return rows;
}

function chunk(type: string, data: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
}

function png(picture: Picture): Buffer {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(pixels(picture), { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

mkdirSync(OUT, { recursive: true });
for (const [name, picture] of Object.entries({ 'inbound-orders-lamp.png': LAMP, 'inbound-orders-chair.png': CHAIR, 'inbound-orders-mug.png': MUG })) {
    const bytes = png(picture);
    writeFileSync(path.join(OUT, name), bytes);
    console.log(`${name}: ${bytes.length} bytes`);
}

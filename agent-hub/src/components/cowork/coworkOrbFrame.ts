import type { NeuralGlyph } from './coworkOrbGlyph';
import type { Fibre, OrbGeometry, Point } from './coworkOrbGeometry';
import { impulseAge, type Axon, type NeuralNetwork } from './coworkOrbNetwork';

export type ActivityTone = 'thinking' | 'executing' | 'repair' | 'rest';
const TAU = 2 * Math.PI;
const COLOURS = ['#3e4a89', '#566baa', '#8494d3', '#9dbbed', '#c1ddfa', '#e1f4ff'];

function drawCore(ctx: CanvasRenderingContext2D, project: Project) {
    const light = project({ x: -.42, y: -.27, z: .47 });
    const mist = ctx.createRadialGradient(light.x * .78, light.y * .78, 3, 0, 0, 104);
    mist.addColorStop(0, 'rgba(51,71,142,.91)');
    mist.addColorStop(.48, 'rgba(25,37,87,.97)');
    mist.addColorStop(.79, 'rgba(32,41,92,.85)');
    mist.addColorStop(.90, 'rgba(56,70,130,.36)');
    mist.addColorStop(1, 'rgba(112,133,194,0)');
    ctx.fillStyle = mist;
    ctx.fillRect(-105, -105, 210, 210);
}

// All layers pass through the same moving volume. Reuse one projected point to
// keep tens of thousands of short-lived objects out of the animation loop.
function projector(time: number) {
    const yaw = time * .39 + .44;
    const sine = Math.sin(yaw), cosine = Math.cos(yaw);
    const twist = .26 * Math.sin(time * .61), flex = .14 * Math.cos(time * .43);
    const lift = .17 * Math.sin(time * .37 + .7), wave = .11 * Math.sin(time * .69 + .45);
    const pitch = .62 * Math.sin(time * .33 + .3);
    const tilt = Math.sin(pitch), up = Math.cos(pitch);
    const roll = .37 * Math.sin(time * .28);
    const right = Math.cos(roll), down = Math.sin(roll);
    const screen: Point = { x: 0, y: 0, z: 0 };
    return ({ x, y, z }: Point) => {
        const bend = twist * (2 * y * y - .58) + flex * x * y;
        const tiltedX = x - bend * z, tiltedZ = z + bend * x;
        const rotatedX = cosine * tiltedX + sine * tiltedZ;
        const yawZ = cosine * tiltedZ - sine * tiltedX;
        const depth = yawZ * up + y * tilt;
        const vertical = y * up - yawZ * tilt;
        const scale = 103 / (1 - depth * .105);
        const sx = rotatedX + lift * y * depth + wave * (y * y - z * x);
        const sy = vertical + flex * (x * x - z * z) - lift * rotatedX * depth + wave * x * y;
        screen.x = scale * (right * sx - down * sy);
        screen.y = scale * (down * sx + right * sy);
        screen.z = depth;
        return screen;
    };
}
type Project = ReturnType<typeof projector>;

function trace(ctx: CanvasRenderingContext2D, project: Project, points: Point[]) {
    ctx.beginPath();
    for (const p of points) {
        const { x, y } = project(p);
        ctx.lineTo(x, y);
    }
}

function drawFibre(ctx: CanvasRenderingContext2D, project: Project, fibre: Fibre) {
    const { points, ribbon } = fibre;
    const { x, y, z } = project(points[Math.floor(points.length / 2)]);
    const light = Math.max(0, .40 + z * .54 - (x + y) * .0018);
    if (ribbon && light > .1) {
        const sheen = ctx.createLinearGradient(x - 28, y - 20, x + 24, y + 22);
        sheen.addColorStop(0, 'rgba(59,67,148,.10)');
        sheen.addColorStop(.43, 'rgba(145,177,243,.85)');
        sheen.addColorStop(.64, 'rgba(111,134,210,.60)');
        sheen.addColorStop(1, 'rgba(78,86,169,.05)');
        ctx.globalAlpha = light * .48;
        ctx.fillStyle = sheen;
        trace(ctx, project, ribbon);
        ctx.fill();
    }
    ctx.strokeStyle = COLOURS[Math.min(5, Math.floor(light * 5.1))];
    ctx.globalAlpha = (.10 + .40 * light) * fibre.bright;
    ctx.lineWidth = .28 + .32 * light;
    trace(ctx, project, points);
    ctx.stroke();
}

function drawGrains(ctx: CanvasRenderingContext2D, project: Project, dust: Point[]) {
    const grains = COLOURS.map(() => new Path2D());
    for (const p of dust) {
        const { x, y, z } = project(p);
        const light = .33 + z * .54 - (x + y) * .0014;
        const bin = Math.min(5, Math.max(0, Math.floor(light * 5.6)));
        const width = .31 + .34 * Math.max(0, light);
        grains[bin].rect(x, y, width, width);
    }
    for (const [i, path] of grains.entries()) {
        ctx.fillStyle = COLOURS[i];
        ctx.globalAlpha = .30 + i * .11;
        ctx.fill(path);
    }
}

function lightPoint(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, light: number) {
    const halo = ctx.createRadialGradient(x, y, 0, x, y, size * 3.5);
    halo.addColorStop(0, '#f3fbff');
    halo.addColorStop(.18, '#cdeaff');
    halo.addColorStop(.35, 'rgba(154,195,255,.52)');
    halo.addColorStop(1, 'rgba(133,158,245,0)');
    ctx.fillStyle = halo;
    ctx.globalAlpha = light;
    ctx.fillRect(x - size * 3.5, y - size * 3.5, size * 7, size * 7);
}

function drawImpulse(ctx: CanvasRenderingContext2D, project: Project, axon: Axon, age: number, light: number) {
    const end = axon.path.length - 1;
    const head = Math.min(1, age / axon.duration) * end;
    const tail = Math.max(0, (age - .24) / axon.duration) * end;
    const i = Math.floor(head), mix = head - i;
    const a = axon.path[i], b = axon.path[Math.min(end, i + 1)];
    trace(ctx, project, axon.path.slice(Math.floor(tail), i + 1));
    const { x, y } = project({ x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix, z: a.z + (b.z - a.z) * mix });
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#d6f3ff';
    ctx.globalAlpha = light * .88;
    ctx.lineWidth = .94;
    ctx.stroke();
    if (age < axon.duration) lightPoint(ctx, x, y, 1.4, light);
}

function drawAxon(ctx: CanvasRenderingContext2D, project: Project, axon: Axon, time: number) {
    const depth = project(axon.path[8]).z;
    const light = Math.max(.07, .45 + depth * .62);
    const age = impulseAge(time, axon.arrival);
    ctx.strokeStyle = '#a3c9f4';
    ctx.lineWidth = .55 + light * .42;
    ctx.globalAlpha = light * (.60 + .32 * Math.max(0, 1 - age));
    trace(ctx, project, axon.path);
    ctx.stroke();
    ctx.lineWidth = .46;
    ctx.globalAlpha = light * .48;
    trace(ctx, project, axon.twig);
    ctx.stroke();
    if (age < axon.duration + .24) drawImpulse(ctx, project, axon, age, light);
}

function drawNetwork(ctx: CanvasRenderingContext2D, project: Project, network: NeuralNetwork, time: number, beat: number) {
    for (const axon of network.axons) drawAxon(ctx, project, axon, time);
    for (const neuron of network.neurons) {
        const { x, y, z } = project(neuron.position);
        const pulse = Math.max(0, 1 - impulseAge(time, neuron.arrival) / .6);
        const light = Math.max(.07, .40 + z * .57);
        lightPoint(ctx, x, y, neuron.radius * (1.10 + pulse * 1.6), Math.min(1, light * (.79 + pulse * .65 + beat * .12)));
    }
}

interface Pattern { marks: (NeuralGlyph | null)[]; focus: number; ordered: boolean; echo?: { since: number; glyph: NeuralGlyph } }
interface Site { x: number; y: number; depth: number; scale: number }

function paintMark(ctx: CanvasRenderingContext2D, glyph: NeuralGlyph, site: Site, time: number) {
    ctx.save();
    ctx.translate(site.x, site.y);
    ctx.scale(site.scale, site.scale);
    const shade = ctx.createRadialGradient(0, 0, 6, 0, 0, 23);
    shade.addColorStop(0, 'rgba(19,32,78,.82)');
    shade.addColorStop(1, 'rgba(19,32,78,0)');
    ctx.fillStyle = shade;
    ctx.fillRect(-23, -23, 46, 46);
    ctx.translate(-20, -20);
    ctx.strokeStyle = glyph.ink;
    ctx.lineWidth = .95;
    ctx.stroke(glyph.outline);
    ctx.strokeStyle = '#a9c7e8';
    ctx.lineWidth = .55;
    ctx.stroke(glyph.links);
    for (const [colour, nodes] of glyph.colours) {
        ctx.fillStyle = colour;
        ctx.fill(nodes);
    }
    for (const [i, p] of glyph.sparks.entries()) {
        const pulse = Math.max(0, Math.sin(time * 1.7 + i * 2.4));
        if (pulse > .6) lightPoint(ctx, p.x, p.y, .95, pulse * .7 * site.depth);
    }
    ctx.restore();
}

function siteAt(i: number, count: number, pattern: Pattern, time: number, project: Project) {
    const angle = (i - pattern.focus) * TAU / count;
    const drift = time * .71 + i * 2.4;
    const world = {
        x: .59 * Math.sin(angle) + .08 * Math.sin(drift),
        y: .37 * Math.cos(angle - .68) + .11 * Math.cos(drift * .81),
        z: .54 * Math.cos(angle) + .08 * Math.sin(drift * .93),
    };
    const { x, y, z } = project(world);
    const depth = Math.max(.08, Math.min(1, .53 + .51 * z));
    const emphasis = 1 / (1 + 3 * Math.abs(i - pattern.focus));
    return { world, x, y, depth, scale: .54 + .52 * depth + .41 * emphasis };
}

// Waves have zero displacement at either end: a fibre can curl and pass through
// the volume while both of its synapses stay attached to their moving steps.
function strandPoint(a: Point, b: Point, t: number, wave: number): Point {
    const bow = Math.sin(Math.PI * t);
    return {
        x: a.x + (b.x - a.x) * t + bow * .20 * Math.sin(wave + 4.7 * t),
        y: a.y + (b.y - a.y) * t + bow * .22 * Math.cos(wave * .79 - 4.1 * t),
        z: a.z + (b.z - a.z) * t + bow * .26 * Math.sin(wave * .64 + 3.2 * t),
    };
}

function drawStrand(ctx: CanvasRenderingContext2D, ends: [Point, Point], project: Project, wave: number, pulse: number) {
    const [a, b] = ends;
    ctx.beginPath();
    for (let j = 0; j <= 20; j++) {
        const point = project(strandPoint(a, b, j / 20, wave));
        ctx.lineTo(point.x, point.y);
    }
    ctx.lineWidth = .91;
    ctx.strokeStyle = '#bedffe';
    ctx.stroke();
    if (pulse >= 0 && pulse <= 1) {
        const head = project(strandPoint(a, b, pulse, wave));
        lightPoint(ctx, head.x, head.y, 1.8, .95);
    }
}

function drawWork(ctx: CanvasRenderingContext2D, pattern: Pattern, time: number, network: NeuralNetwork, project: Project) {
    const { marks, ordered } = pattern;
    const sites = marks.map((_, i) => siteAt(i, marks.length, pattern, time, project));
    const pulse = (time * 1.35) % Math.max(1, sites.length - 1);
    for (let i = 1; i < sites.length; i++) {
        const end = sites[ordered ? i : sites.length - 1];
        ctx.globalAlpha = .47 + .50 * end.depth;
        drawStrand(ctx, [sites[i - 1].world, end.world], project, time * .87 + i * 2, pulse - (i - 1));
    }
    if (pattern.echo && time - pattern.echo.since < 2.5) {
        const fade = (time - pattern.echo.since) / 2.5;
        const { x, y } = project({ x: -.48 * fade, y: .26 - .60 * fade, z: .45 - fade });
        ctx.globalAlpha = .55 * (1 - fade);
        paintMark(ctx, pattern.echo.glyph, { x, y, depth: 0, scale: 1.2 - .88 * fade }, time);
    }
    for (const i of sites.map((_, i) => i).sort((a, b) => sites[a].depth - sites[b].depth)) {
        const site = sites[i], mark = marks[i];
        if (!mark) continue;
        const root = network.neurons[(30 + i) % network.neurons.length].position;
        ctx.globalAlpha = .26;
        drawStrand(ctx, [root, site.world], project, time * .63 + i, -1);
        ctx.globalAlpha = .34 + .66 * site.depth;
        paintMark(ctx, mark, site, time);
    }
}

export function drawOrbFrame(ctx: CanvasRenderingContext2D, geometry: OrbGeometry, time: number, beat: number, pattern: Pattern) {
    const size = ctx.canvas.width;
    ctx.resetTransform();
    ctx.clearRect(0, 0, size, size);
    const breath = 1 + .036 * Math.sin(time * TAU / 7);
    ctx.setTransform(size / 256 * breath, 0, 0, size / 256 * breath, size / 2, size / 2);
    const project = projector(time);
    drawCore(ctx, project);
    ctx.lineCap = 'round';
    for (const fibre of geometry.fibres) drawFibre(ctx, project, fibre);
    drawGrains(ctx, project, geometry.dust);
    drawNetwork(ctx, project, geometry.network, time, beat);
    drawWork(ctx, pattern, time, geometry.network, project);
    ctx.globalAlpha = 1;
}

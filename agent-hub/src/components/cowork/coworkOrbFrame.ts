import { drawCore } from './coworkOrbCore';
import type { OrbLook } from './coworkOrbAppearance';
import { drawDeepSky } from './coworkOrbDeepSky';
import type { NeuralGlyph } from './coworkOrbGlyph';
import type { Fibre, OrbGeometry, Point } from './coworkOrbGeometry';
import { impulseAge, type Axon, type NeuralNetwork } from './coworkOrbNetwork';

export type ActivityTone = 'thinking' | 'executing' | 'repair' | 'rest';
const TAU = 2 * Math.PI;
const COLOURS = ['#3e4a89', '#566baa', '#8494d3', '#9dbbed', '#c1ddfa', '#e1f4ff'];

// All layers pass through the same moving volume. Reuse one projected point to
// keep tens of thousands of short-lived objects out of the animation loop.
function projector(time: number) {
    const yaw = time * .27 + .44;
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

// Sample one smooth displacement field for the fibres, synapses and passing
// impulses. Shared world coordinates always meet, including at branch points.
function driftingNetwork(project: Project, time: number): Project {
    const point = { x: 0, y: 0, z: 0 };
    return ({ x, y, z }) => {
        const phase = 3.6 * x - 2.8 * y + 1.7 * z + time * .70;
        const curl = 2.1 * y + 2.9 * z - time * .47;
        point.x = x + .050 * Math.sin(curl);
        point.y = y + .055 * Math.sin(phase) + .018 * Math.cos(curl);
        point.z = z + .034 * Math.cos(phase + curl);
        return project(point);
    };
}

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
        ctx.globalAlpha = light * .21;
        ctx.fillStyle = sheen;
        trace(ctx, project, ribbon);
        ctx.fill();
    }
    ctx.strokeStyle = COLOURS[Math.min(5, Math.floor(light * 5.1))];
    ctx.globalAlpha = (.05 + .22 * light) * fibre.bright;
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
        ctx.globalAlpha = .14 + i * .048;
        ctx.fill(path);
    }
}

function drawNebula(ctx: CanvasRenderingContext2D, project: Project, palette: OrbLook) {
    for (let i = -5; i <= 5; i++) {
        const u = i / 6;
        const { x, y } = project({ x: u, y: -.35 * u + .07 * Math.sin(4 * u), z: .18 * Math.cos(3 * u) });
        const radius = 15 + 12 * (1 - Math.abs(u));
        const haze = ctx.createRadialGradient(x, y, 0, x, y, radius);
        haze.addColorStop(0, palette.mistColor + '38');
        haze.addColorStop(.5, 'rgba(112,127,193,.09)');
        haze.addColorStop(1, 'rgba(97,109,172,0)');
        ctx.fillStyle = haze;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
}

function drawStarBand(ctx: CanvasRenderingContext2D, project: Project, stars: Point[], palette: OrbLook) {
    const fine = new Path2D(), bright = new Path2D();
    const count = stars.length;
    for (let i=0; i<count; i++) {
        const star = stars[i];
        const { x, y, z } = project(star);
        const standout = i % 29 === 0;
        const radius = (standout ? .48 : .19) * (1 + .23 * z);
        if (standout) {
            bright.moveTo(x + radius, y);
            bright.arc(x, y, radius, 0, TAU);
        } else fine.rect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ctx.globalAlpha = .64;
    ctx.fillStyle = palette.starColor;
    ctx.fill(fine);
    ctx.globalAlpha = .74;
    ctx.fillStyle = '#e2dff8';
    ctx.fill(bright);
    ctx.globalAlpha = 1;
}

function lightPoint(ctx: CanvasRenderingContext2D, { x, y }: { x: number; y: number }, size: number, light: number, color = '#cdeaff') {
    const halo = ctx.createRadialGradient(x, y, 0, x, y, size * 3.5);
    halo.addColorStop(0, '#f3fbff');
    halo.addColorStop(.18, color);
    halo.addColorStop(.35, color + '85');
    halo.addColorStop(1, color + '00');
    ctx.fillStyle = halo;
    ctx.globalAlpha = light;
    ctx.fillRect(x - size * 3.5, y - size * 3.5, size * 7, size * 7);
}

interface NeuralScene {
    project: Project; look: OrbLook; time: number; intensity: number; lineInk: string | CanvasGradient;
}

function drawImpulse(ctx: CanvasRenderingContext2D, scene: NeuralScene, axon: Axon, age: number, light: number) {
    const { project, look } = scene;
    const end = axon.path.length - 1;
    const head = Math.min(1, age / axon.duration) * end;
    const tail = Math.max(0, (age - .24) / axon.duration) * end;
    const i = Math.floor(head), mix = head - i;
    const a = axon.path[i], b = axon.path[Math.min(end, i + 1)];
    trace(ctx, project, axon.path.slice(Math.floor(tail), i + 1));
    const { x, y } = project({ x: a.x + (b.x - a.x) * mix, y: a.y + (b.y - a.y) * mix, z: a.z + (b.z - a.z) * mix });
    ctx.lineTo(x, y);
    ctx.strokeStyle = look.pulseColor;
    ctx.globalAlpha = light * .88;
    ctx.lineWidth = .94;
    ctx.stroke();
    if (age < axon.duration) lightPoint(ctx, { x, y }, 1.4, light);
}

function drawAxon(ctx: CanvasRenderingContext2D, scene: NeuralScene, axon: Axon) {
    const { project, time, intensity, look, lineInk } = scene;
    const depth = project(axon.path[8]).z;
    const light = Math.max(.07, .45 + depth * .62);
    const age = impulseAge(time, axon.arrival);

    const boost = look.lightSurface ? 1.35 : 1;
    ctx.strokeStyle = lineInk;
    ctx.lineWidth = .55 + light * .42;
    ctx.globalAlpha = Math.min(1,boost * light * (.29 + intensity * .22 * Math.max(0, 1 - age)));
    trace(ctx, project, axon.path);
    {
        const alpha = ctx.globalAlpha;
        const width = ctx.lineWidth;
        ctx.globalAlpha = alpha * .17;
        ctx.lineWidth = width * 3;
        ctx.stroke();
        ctx.globalAlpha = alpha * .77;
        ctx.lineWidth = width * .8;
    }
    ctx.stroke();
    ctx.lineWidth = .46;
    ctx.globalAlpha = light * .21 * boost;
    trace(ctx, project, axon.twig);
    ctx.stroke();
    if (intensity > .01 && age < axon.duration + .24) drawImpulse(ctx, scene, axon, age, light * intensity);
}

function nerveInk(ctx: CanvasRenderingContext2D, look: OrbLook) {

    if (look.lightSurface) {
        const gradient = ctx.createRadialGradient(0,0,0,0,0,104);
        gradient.addColorStop(0,look.pulseColor);
        gradient.addColorStop(.79,look.nerveColor);
        gradient.addColorStop(.95,look.rimColor);
        gradient.addColorStop(1,look.rimColor + 'a8');
        return gradient;
    }
    return look.nerveColor;
}

function drawNetwork(ctx: CanvasRenderingContext2D, project: Project, network: NeuralNetwork, clock: { time: number; beat: number }, look: OrbLook) {
    const time = clock.time * .46;
    const beat = clock.beat;
    // The backplate under a neuron changes from a dark core to the page at
    // the limb. Vary contrast over that same distance, including along one axon.
    const onLight = look.lightSurface;
    const scene = { project, time, intensity: beat * 2, look, lineInk: nerveInk(ctx, look) };
    for (const axon of network.axons) drawAxon(ctx, scene, axon);
    for (const neuron of network.neurons) {
        const { x, y, z } = project(neuron.position);
        const pulse = beat * 2 * Math.max(0, 1 - impulseAge(time, neuron.arrival) / .6);
        const light = Math.max(.07, .40 + z * .57);
        if (onLight) {
            const edge = Math.min(1,Math.max(0,(Math.hypot(x,y)-80)/21));
            if (edge > 0) {
                const radius = neuron.radius * (2.8 + pulse);
                const shade = ctx.createRadialGradient(x,y,0,x,y,radius);
                shade.addColorStop(0,look.rimColor);
                shade.addColorStop(.45,look.rimColor+'76');
                shade.addColorStop(1,look.rimColor+'00');
                ctx.fillStyle = shade;
                ctx.globalAlpha = edge * (.18 + .32 * light);
                ctx.fillRect(x-radius,y-radius,radius*2,radius*2);
            }
        }
        lightPoint(ctx, { x, y }, neuron.radius * (1.10 + pulse * 1.6), Math.min(1, light * (onLight ? 1.5 : 1) * (.42 + pulse * .60 + beat * .12)),look.nerveColor);
    }
}

export interface OrbPattern { marks: (NeuralGlyph | null)[]; focus: number; ordered: boolean; opacity: number; active: number; from: number; phase: number; converge: boolean }
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
    const opacity = ctx.globalAlpha;
    for (const [i, p] of glyph.sparks.entries()) {
        const pulse = Math.max(0, Math.sin(time * 1.7 + i * 2.4));
        if (pulse > .6) lightPoint(ctx, p, .95, pulse * .7 * site.depth * opacity);
    }
    ctx.restore();
}

function siteAt(i: number, count: number, pattern: OrbPattern, time: number, project: Project) {
    // A step change shifts the light, while each icon keeps its orbit.
    const angle = i * TAU / count;
    const drift = time * .71 + i * 2.4;
    const world = {
        x: .59 * Math.sin(angle) + .08 * Math.sin(drift),
        y: .37 * Math.cos(angle - .68) + .11 * Math.cos(drift * .81),
        z: .54 * Math.cos(angle) + .08 * Math.sin(drift * .93),
    };
    const { x, y, z } = project(world);
    const depth = Math.max(.08, Math.min(1, .53 + .51 * z));
    const emphasis = 1 / (1 + 3 * Math.abs(i - pattern.focus));
    return { world, x, y, depth, emphasis, scale: .48 + .50 * depth + .52 * emphasis };
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
        lightPoint(ctx, head, 1.8, ctx.globalAlpha);
    }
}

function drawStepSignal(ctx: CanvasRenderingContext2D, scene: { pattern: OrbPattern; sites: ReturnType<typeof siteAt>[]; network: NeuralNetwork }, project: Project, time: number) {
    const { pattern, sites, network } = scene;
    const active = sites[pattern.active];
    if (!active || pattern.phase >= 1) return;
    const previous = sites[pattern.from];
    ctx.globalAlpha = pattern.opacity * .8 * Math.sin(Math.PI * pattern.phase);
    if (previous) drawStrand(ctx, [previous.world, active.world], project, time + pattern.from, pattern.phase);
    const opacity = pattern.opacity * .65 * Math.sin(Math.PI * pattern.phase);
    for (let i = 0; i < (pattern.converge ? 3 : 1); i++) {
        const root = network.neurons[(30 + 19 * i + pattern.active) % network.neurons.length].position;
        ctx.globalAlpha = opacity;
        drawStrand(ctx, [root, active.world], project, time + i, pattern.converge ? pattern.phase : 1 - pattern.phase);
    }
}

function drawWork(ctx: CanvasRenderingContext2D, pattern: OrbPattern, time: number, network: NeuralNetwork, project: Project) {
    const { marks, ordered } = pattern;
    const sites = marks.map((_, i) => siteAt(i, marks.length, pattern, time, project));

    for (let i = 1; i < sites.length; i++) {
        const end = sites[ordered ? i : sites.length - 1];
        ctx.globalAlpha = pattern.opacity * (.24 + .46 * end.depth);
        drawStrand(ctx, [sites[i - 1].world, end.world], project, time * .87 + i * 2, -1);
    }
    drawStepSignal(ctx, { pattern, sites, network }, project, time);
    const order = sites.map((_, i) => i).sort((a, b) => Number(a === pattern.active) - Number(b === pattern.active) || (sites[a].depth + sites[a].emphasis) - (sites[b].depth + sites[b].emphasis));
    for (const [layer, i] of order.entries()) {
        const site = sites[i], mark = marks[i];
        if (!mark) continue;
        const root = network.neurons[(30 + i) % network.neurons.length].position;
        ctx.globalAlpha = pattern.opacity * .11;
        drawStrand(ctx, [root, site.world], project, time * .63 + i, -1);
        const active = sites[pattern.active];
        const space = active && active !== site ? Math.min(1, Math.max(0, (Math.hypot(site.x - active.x, site.y - active.y) - 24) / 24)) * .55 : 1;
        const clearance = order.slice(layer + 1).reduce((alpha, j) => Math.min(alpha,
            1 - Math.min(1, 4 * (sites[j].depth + sites[j].emphasis - site.depth - site.emphasis)) *
            Math.max(0, 1 - Math.hypot(site.x - sites[j].x, site.y - sites[j].y) / (18 * (site.scale + sites[j].scale)))), 1);
        ctx.globalAlpha = pattern.opacity * (.16 + .44 * site.depth + .40 * site.emphasis) * clearance * space;
        paintMark(ctx, mark, site, time);
    }
}

export function drawOrbFrame(ctx: CanvasRenderingContext2D, geometry: OrbGeometry, clock: { time: number; beat: number }, patterns: OrbPattern[], look: OrbLook) {
    const { time } = clock;
    const size = ctx.canvas.width;
    ctx.resetTransform();
    ctx.clearRect(0, 0, size, size);
    const breath = .95 * (1 + look.breath * Math.sin(time * TAU / 7));
    ctx.setTransform(size / 256 * breath, 0, 0, size / 256 * breath, size / 2, size / 2);
    const project = projector(time);
    ctx.globalAlpha = 1 - look.transparency;
    drawCore(ctx, project({ x: -.42, y: -.27, z: .47 }), look);
    drawDeepSky(ctx, time, look);
    ctx.globalAlpha = 1;
    drawNebula(ctx, project, look);
    ctx.lineCap = 'round';
    for (const fibre of geometry.fibres) drawFibre(ctx, project, fibre);
    drawGrains(ctx, project, geometry.dust);
    drawStarBand(ctx, project, geometry.stars, look);
    const neuralProject = driftingNetwork(project, time);
    drawNetwork(ctx, neuralProject, geometry.network, clock, look);
    for (const pattern of patterns) drawWork(ctx, pattern, time * .55, geometry.network, neuralProject);
    ctx.globalAlpha = 1;
}

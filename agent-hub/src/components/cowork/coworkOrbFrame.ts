import type { NeuralGlyph } from './coworkOrbGlyph';
import type { Fibre, OrbGeometry, Point } from './coworkOrbGeometry';
import { impulseAge, type Axon, type NeuralNetwork } from './coworkOrbNetwork';

export type ActivityTone = 'thinking' | 'executing' | 'repair' | 'rest';
const TAU = 2 * Math.PI;
const COLOURS = ['#3e4a89', '#566baa', '#8494d3', '#9dbbed', '#c1ddfa', '#e1f4ff'];

function drawCore(ctx: CanvasRenderingContext2D, time: number) {
    const drift = Math.sin(time * .36);
    const mist = ctx.createRadialGradient(-24 + 4 * drift, -30, 3, 0, 0, 104);
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
    const yaw = time * .17 + .44;
    const sine = Math.sin(yaw), cosine = Math.cos(yaw);
    const twist = .26 * Math.sin(time * .61), flex = .14 * Math.cos(time * .43);
    const lift = .17 * Math.sin(time * .37 + .7), wave = .11 * Math.sin(time * .69 + .45);
    const screen: Point = { x: 0, y: 0, z: 0 };
    return ({ x, y, z }: Point) => {
        const bend = twist * (2 * y * y - .58) + flex * x * y;
        const tiltedX = x - bend * z, tiltedZ = z + bend * x;
        const rotatedX = cosine * tiltedX + sine * tiltedZ;
        const depth = cosine * tiltedZ - sine * tiltedX;
        const scale = 103 / (1 - depth * .105);
        screen.x = scale * (rotatedX + lift * y * depth + wave * (y * y - z * x));
        screen.y = scale * (y + flex * (x * x - z * z) - lift * rotatedX * depth + wave * x * y);
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

function paintMark(ctx: CanvasRenderingContext2D, glyph: NeuralGlyph, x: number, y: number, scale: number, time: number) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.translate(-20, -20);
    ctx.strokeStyle = '#bfd9f4';
    ctx.fillStyle = '#e2efff';
    ctx.lineWidth = .57;
    ctx.stroke(glyph.links);
    ctx.fill(glyph.nodes);
    for (const [i, p] of glyph.sparks.entries()) {
        const pulse = Math.max(0, Math.sin(time * 1.7 + i * 2.4));
        if (pulse > .6) lightPoint(ctx, p.x, p.y, 1.2, pulse * .8);
    }
    ctx.restore();
}

// Keep the marks facing the viewer while their junctions drift with the volume.
function drawWork(ctx: CanvasRenderingContext2D, marks: (NeuralGlyph | null)[], time: number, network: NeuralNetwork, project: Project) {
    const sites = [[0, -5], [-46, 26], [46, 23], [15, -53]];
    for (const [i, glyph] of marks.entries()) {
        if (!glyph) continue;
        const x = sites[i][0] + 3 * Math.sin(time * .52 + i), y = sites[i][1] + 2 * Math.cos(time * .46 + i);
        const root = project(network.neurons[30 + i].position);
        ctx.beginPath();
        ctx.moveTo(root.x, root.y);
        ctx.bezierCurveTo(root.x + 7, root.y - 8, x - 12, y + 14, x, y);
        if (i) ctx.quadraticCurveTo(x * .32, y + 5, 3 * Math.sin(time * .52), -5 + 2 * Math.cos(time * .46));
        ctx.strokeStyle = 'rgba(184,222,255,.72)';
        ctx.globalAlpha = 1;
        ctx.lineWidth = .72;
        ctx.stroke();
        paintMark(ctx, glyph, x, y, i ? .64 : .8, time);
    }
}

export function drawOrbFrame(ctx: CanvasRenderingContext2D, geometry: OrbGeometry, time: number, beat: number, marks: (NeuralGlyph | null)[]) {
    const size = ctx.canvas.width;
    ctx.resetTransform();
    ctx.clearRect(0, 0, size, size);
    const breath = 1 + .036 * Math.sin(time * TAU / 7);
    ctx.setTransform(size / 256 * breath, 0, 0, size / 256 * breath, size / 2, size / 2);
    drawCore(ctx, time);
    const project = projector(time);
    ctx.lineCap = 'round';
    for (const fibre of geometry.fibres) drawFibre(ctx, project, fibre);
    drawGrains(ctx, project, geometry.dust);
    drawNetwork(ctx, project, geometry.network, time, beat);
    drawWork(ctx, marks, time, geometry.network, project);
    ctx.globalAlpha = 1;
}

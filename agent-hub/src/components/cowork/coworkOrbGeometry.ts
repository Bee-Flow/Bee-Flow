import { makeNeuralNetwork } from './coworkOrbNetwork';

// Each bundle follows a contour of the same smooth field on a sphere. Neighbouring
// seeds stay close through a fold, but separate again when the field opens out.
export interface Point { x: number; y: number; z: number }
export interface Fibre { points: Point[]; bright: number; ribbon?: Point[] }

const TAU = Math.PI * 2;

function unit(x: number, y: number, z: number): Point {
    const length = Math.hypot(x, y, z);
    return { x: x / length, y: y / length, z: z / length };
}

function advance({ x, y, z }: Point): Point {
    const a = Math.cos(2.6 * x + 1.4 * y - z);
    const b = Math.cos(2.8 * y + 1.7 * z + .9);
    const c = Math.cos(3.2 * z - 1.9 * x - .7);
    const d = Math.cos(5.8 * x - 3.7 * y + 2.8 * z + 1.4);
    const gx = 2.6 * a - 1.4 * c + .94 * d;
    const gy = 1.4 * a + 2.2 * b - .60 * d;
    const gz = -a + 1.36 * b + 2.35 * c + .45 * d;
    const tx = y * gz - z * gy, ty = z * gx - x * gz, tz = x * gy - y * gx;
    const step = .039 / Math.max(.65, Math.hypot(tx, ty, tz));
    return unit(x + step * tx, y + step * ty, z + step * tz);
}

function ribbonEdge(points: Point[], spread: number) {
    const left = [], right = [];
    for (const [i, p] of points.entries()) {
        const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const across = unit(p.y * dz - p.z * dy, p.z * dx - p.x * dz, p.x * dy - p.y * dx);
        const width = spread * Math.sin(Math.PI * i / (points.length - 1));
        left.push({ x: p.x + across.x * width, y: p.y + across.y * width, z: p.z + across.z * width });
        right.push({ x: p.x - across.x * width, y: p.y - across.y * width, z: p.z - across.z * width });
    }
    return left.concat(right.reverse());
}

function addBundle(bundle: number, random: () => number, fibres: Fibre[], dust: Point[]) {
    const y = 1 - 2 * (bundle + .5) / 104;
    const longitude = bundle * 2.399963 + .19 * random();
    const rim = Math.sqrt(1 - y * y);
    const x = rim * Math.cos(longitude), z = rim * Math.sin(longitude);
    const depth = .62 + .36 * Math.cbrt(random());
    const phase = random() * TAU;
    const length = 25 + Math.floor(random() * 44);
    for (let thread = 0; thread < 5; thread++) {
        let point = unit(x + .055 * (random() - .5), y + .07 * (random() - .5), z + .065 * (random() - .5));
        const points = [];
        for (let i = 0; i < length; i++) {
            const radius = depth + .035 * Math.sin(phase + i * .049) + thread * .004;
            const p = { x: radius * point.x, y: radius * point.y, z: radius * point.z };
            points.push(p);
            // Scatter grains across this ribbon; its width thins towards both ends.
            const width = .014 + .095 * Math.sin(Math.PI * i / length);
            dust.push({ x: p.x + width * (random() - .5), y: p.y + width * (random() - .5), z: p.z + width * (random() - .5) });
            point = advance(point);
        }
        if (thread === 0 || thread === 2) {
            fibres.push({ points, bright: .35 + random() * .65,
                ribbon: thread === 0 ? ribbonEdge(points, .025 + random() * .06) : undefined });
        }
    }
}

export function makeOrbGeometry() {
    let seed = 87101;
    const random = () => {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        return seed / 4294967296;
    };
    const fibres: Fibre[] = [];
    const dust: Point[] = [];
    for (let i = 0; i < 104; i++) addBundle(i, random, fibres, dust);
    for (let i = 0; i < 1300; i++) {
        const y = 2 * random() - 1, angle = TAU * random();
        const rim = Math.sqrt(1 - y * y);
        const radius = .78 + .25 * random();
        dust.push({ x: radius * rim * Math.cos(angle), y: radius * y, z: radius * rim * Math.sin(angle) });
    }
    return { fibres, dust, network: makeNeuralNetwork(random) };
}

export type OrbGeometry = ReturnType<typeof makeOrbGeometry>;

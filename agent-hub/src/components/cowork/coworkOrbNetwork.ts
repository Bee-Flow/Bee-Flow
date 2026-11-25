import type { Point } from './coworkOrbGeometry';

const PERIOD = 6.4;
export interface Neuron { position: Point; arrival: number; radius: number }
export interface Axon { path: Point[]; arrival: number; duration: number; twig: Point[] }
export interface NeuralNetwork { neurons: Neuron[]; axons: Axon[] }

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// Each impulse follows the drawn curve; a daughter branch starts exactly when
// the impulse reaches its parent. Its short dendrite sprouts from the same path.
function connect(parent: Neuron, child: Neuron, random: () => number): Axon {
    const a = parent.position, b = child.position;
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const bend = .36 + .65 * random();
    const side = { x: bend * (dy * a.z - dz * a.y), y: bend * (dz * a.x - dx * a.z), z: bend * (dx * a.y - dy * a.x) };
    const path = Array.from({ length: 17 }, (_, index) => {
        const t = index / 16;
        const arc = Math.sin(Math.PI * t) * (.91 - 1.5 * t);
        return { x: a.x + t * dx + arc * side.x, y: a.y + t * dy + arc * side.y, z: a.z + t * dz + arc * side.z };
    });
    const duration = path.slice(1).reduce((sum, p, i) => sum + distance(path[i], p), 0) * 1.55;
    const stem = path[8];
    const twig = [stem, path[9], { x: stem.x + .17 * dx - .11 * side.x, y: stem.y + .17 * dy - .11 * side.y, z: stem.z + .17 * dz - .11 * side.z },
        { x: stem.x + .25 * dx - .34 * side.x, y: stem.y + .25 * dy - .34 * side.y, z: stem.z + .25 * dz - .34 * side.z }];
    child.arrival = parent.arrival + duration;
    return { path, arrival: parent.arrival, duration, twig };
}

export function makeNeuralNetwork(random: () => number): NeuralNetwork {
    const count = 96;
    const neurons = Array.from({ length: count }, (_, i) => {
        const y = 1 - 2 * (i + .5) / count;
        const angle = i * 2.399963 + random() * .37;
        const rim = Math.sqrt(1 - y * y);
        const radius = .36 + .63 * Math.cbrt(random());
        return { position: { x: radius * rim * Math.cos(angle), y: radius * y, z: radius * rim * Math.sin(angle) }, arrival: 0, radius: .66 + random() * .8 };
    });
    // Grow four local trees into the same volume. Closest neighbours produce
    // irregular forked paths at multiple depths, without a triangular wireframe.
    const parents = new Int16Array(count);
    const nearest = new Float64Array(count).fill(Infinity);
    function attach(index: number) {
        nearest[index] = -1;
        for (const [i, neuron] of neurons.entries()) {
            const d = distance(neuron.position, neurons[index].position);
            if (d < nearest[i]) { nearest[i] = d; parents[i] = index; }
        }
    }
    for (const [i, root] of [8, 30, 62, 88].entries()) {
        neurons[root].arrival = i * PERIOD / 4;
        attach(root);
    }
    const axons: Axon[] = [];
    for (let n = 4; n < count; n++) {
        let child = -1;
        for (let i = 0; i < count; i++) {
            if (nearest[i] >= 0 && (child < 0 || nearest[i] < nearest[child])) child = i;
        }
        axons.push(connect(neurons[parents[child]], neurons[child], random));
        attach(child);
    }
    return { neurons, axons };
}

export function impulseAge(time: number, arrival: number) {
    return ((time - arrival) % PERIOD + PERIOD) % PERIOD;
}

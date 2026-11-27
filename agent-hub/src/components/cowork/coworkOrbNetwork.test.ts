import { expect, it } from 'vitest';
import type { Point } from './coworkOrbGeometry';
import { impulseAge, makeNeuralNetwork } from './coworkOrbNetwork';

it('passes a travelling signal to each outgoing connection at the instant it reaches the junction', () => {
    const { neurons, axons } = makeNeuralNetwork(() => .58);
    const key = (p: Point) => [p.x, p.y, p.z].map(n => n.toFixed(7)).join(',');
    const arrivals = new Map(neurons.map(n => [key(n.position), n.arrival]));
    const outgoing = new Map<string, number>();
    for (const axon of axons) {
        const start = key(axon.path[0]), end = key(axon.path[axon.path.length - 1]);
        expect(axon.duration).toBeGreaterThan(0);
        expect(axon.arrival).toBe(arrivals.get(start));
        expect(arrivals.get(end)).toBeCloseTo(axon.arrival + axon.duration);
        outgoing.set(start, (outgoing.get(start) ?? 0) + 1);
    }
    expect(Math.max(...outgoing.values())).toBeGreaterThan(1);
    expect(impulseAge(9.2, 9.2)).toBe(0);
    expect(impulseAge(9.3, 9.2)).toBeCloseTo(.1);
});

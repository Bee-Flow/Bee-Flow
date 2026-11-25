import type { OrbStep } from '@/api/coworkPlan.types';
import type { OrbPattern } from './coworkOrbFrame';

interface Layout { ordered: boolean; target: number; step?: OrbStep; reduced: boolean }

export function updatePattern(layers: OrbPattern[], marks: OrbPattern['marks'], layout: Layout, progress: { id: string }) {
    const { ordered, target, step, reduced } = layout;
    let current = layers.at(-1);
    if (!current || current.ordered !== ordered || current.marks.length !== marks.length || marks.some((m, i) => m?.id !== current?.marks[i]?.id)) {
        current = { marks, ordered, focus: target, opacity: current && !reduced ? 0 : 1, active: -1, from: -1, phase: 1, converge: false };
        layers.push(current);
    }
    current.marks = marks;
    current.active = step ? marks.findIndex(m => m?.id === step.id) : -1;
    current.converge = step?.kind === 'ai';
    if (step && current.active >= 0 && progress.id !== step.id) {
        current.from = marks.findIndex(m => m?.id === progress.id);
        current.phase = reduced ? 1 : 0;
        progress.id = step.id;
    }
}

export function advanceLayers(layers: OrbPattern[], target: number, seconds: number) {
    const current = layers.at(-1);
    if (!current) return;
    const blend = 1 - Math.exp(-seconds * 5);
    for (const layer of layers) layer.opacity += ((layer === current ? 1 : 0) - layer.opacity) * blend;
    current.phase = Math.min(1, current.phase + seconds / 2.4);
    current.focus += (target - current.focus) * (1 - Math.exp(-seconds * 3.5));
    for (let i = layers.length - 2; i >= 0; i--) {
        if (layers[i].opacity < .005) layers.splice(i, 1);
    }
}


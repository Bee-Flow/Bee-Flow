import type { OrbStep } from '@/api/coworkPlan.types';
import { useEffect, useRef } from 'react';
import { Brain, Workflow, Save, ScanLine, Play, Wrench, Eye, Pencil, CircleX, Boxes, Send, Hand } from 'lucide-react';
import IntegrationLogo from '@/components/automation/Builder/flow/nodes/IntegrationLogo';
import { paletteItemForType } from '@/components/automation/Builder/flow/stepPalette';
import { readOrbGlyph, type NeuralGlyph } from './coworkOrbGlyph';

const ICONS = { thinking: Brain, creating: Workflow, saving: Save, testing: ScanLine, executing: Play, repair: Wrench, rest: Eye, edit: Pencil, discard: CircleX, deliver: Send, ask: Hand };
export interface OrbWork { flow?: OrbStep[]; focus?: number; action?: keyof typeof ICONS; apps?: (string | null | undefined)[] | null; stepType?: string }

export default function CoworkOrbSources({ action = 'thinking', apps, flow, focus, stepType, onRead }: OrbWork & { onRead: (marks: (NeuralGlyph | null)[]) => void }) {
    const source = useRef<HTMLDivElement>(null);
    const ids = [...new Set(apps?.filter((app): app is string => !!app))];
    const steps = flow?.map(step => ({
        id: step.id, app: step.app, Icon: paletteItemForType(step.type ?? '')?.icon ??
            (step.kind === 'ai' ? Brain : step.kind === 'ask' ? Hand : step.kind === 'deliver' ? Send : Boxes),
    })) ?? [];
    const marks = steps.length ? steps : ids.map(id => ({ id, app: id, Icon: Boxes }));
    if (!steps.length || focus === undefined || focus < 0 || focus >= steps.length) {
        marks.push({ id: 'activity-' + action, app: null, Icon: paletteItemForType(stepType ?? '')?.icon ?? ICONS[action] });
    }
    const key = JSON.stringify([marks.map(mark => [mark.id, mark.app]), flow?.map(s => [s.type, s.kind]), stepType]);
    useEffect(() => {
        const root = source.current;
        if (!root || typeof CanvasRenderingContext2D === 'undefined' || typeof Path2D === 'undefined') return;
        let version = 0;
        const read = async () => {
            const current = ++version;
            const marks = await Promise.all(Array.from(root.children, readOrbGlyph));
            if (version === current) onRead(marks);
        };
        void read();
        const observer = new MutationObserver(() => { void read(); });
        observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
        return () => { version++; observer.disconnect(); };
    }, [key, onRead]);
    return <div hidden ref={source}>{marks.map(({ id, app, Icon }) => <span key={id} data-mark={id}>
        {app ? <IntegrationLogo integrationId={app} size={40} fallback={<Icon />} /> : <Icon />}
    </span>)}</div>;
}

import { useEffect, useRef } from 'react';
import { Brain, Workflow, Save, ScanLine, Play, Wrench, ClipboardCheck, Pencil, CircleX, Boxes, Send, Hand } from 'lucide-react';
import IntegrationLogo from '@/components/automation/Builder/flow/nodes/IntegrationLogo';
import { paletteItemForType } from '@/components/automation/Builder/flow/stepPalette';
import { readOrbGlyph, type NeuralGlyph } from './coworkOrbGlyph';

const ICONS = { thinking: Brain, creating: Workflow, saving: Save, testing: ScanLine, executing: Play, repair: Wrench, rest: ClipboardCheck, edit: Pencil, discard: CircleX, deliver: Send, ask: Hand };
export interface OrbWork { action?: keyof typeof ICONS; apps?: (string | null | undefined)[] | null; stepType?: string }

export default function CoworkOrbSources({ action = 'thinking', apps, stepType, onRead }: OrbWork & { onRead: (marks: (NeuralGlyph | null)[]) => void }) {
    const source = useRef<HTMLDivElement>(null);
    const ids = [...new Set(apps?.filter((app): app is string => !!app))].slice(0, 3);
    const key = JSON.stringify([action, stepType, ids]);
    const Icon = paletteItemForType(stepType ?? '')?.icon ?? ICONS[action];
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
    return <div hidden ref={source}><span><Icon /></span>{ids.map(id => <span key={id}><IntegrationLogo integrationId={id} size={40} fallback={<Boxes />} /></span>)}</div>;
}

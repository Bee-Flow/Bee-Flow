import {
    AppWindow, Bell, BookOpen, Box, Braces, ChevronsDown, Clock, Code2, Copy, FileSignature, FileText, Globe,
    Hourglass, Layers, LogOut, OctagonX, Pencil, Presentation, RectangleHorizontal, Repeat, ScanText,
    ShieldCheck, Sparkles, Split, Table2, VenetianMask, Workflow, Wrench, Zap, ClipboardList,
    type LucideIcon,
} from 'lucide-react';
import type { ComponentType } from 'react';
import IntegrationLogoJs from '../flow/nodes/IntegrationLogo';
import type { FlowStep } from '../flow/types';

// Untyped JS component; its props are checked there.
const IntegrationLogo = IntegrationLogoJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * The glyph the canvas card of this step carries, for the drawer header's
 * 32px tile. Mirrors the per-node `icon={…}` choices in flow/nodes/*; an app
 * action shows its IntegrationLogo only when the app HAS one, and the wrench
 * the card falls back to otherwise.
 */
const TYPE_ICON: Record<string, LucideIcon> = {
    trigger: Zap, ai_step: Sparkles, approval: ShieldCheck, fill_document: FileSignature,
    dedupe: Copy, knowledge_write: BookOpen, layer_output: LogOut, call_step: Box,
    aggregate: Layers, return_to_app: AppWindow, datetime: Clock, stop_error: OctagonX,
    set: Pencil, datatable: Table2, switch: Split, parse_json: Braces, presentation: Presentation,
    call_layer: Layers, slide: RectangleHorizontal, tokenize: VenetianMask, untokenize: VenetianMask,
    guard: ShieldCheck, wait: Hourglass, generate_document: FileText, code: Code2,
    data_extraction: ScanText, filter: Split, condition: Split, http_request: Globe,
    notification: Bell, limit: ChevronsDown, loop: Repeat, form_page: ClipboardList,
};

export default function StepGlyph({ step, size = 16 }: { step: FlowStep; size?: number }) {
    const Icon = TYPE_ICON[String(step.type || '')] || Workflow;
    if (step.type === 'integration_action' && step.tool) {
        return <IntegrationLogo tool={step.tool} size={size} fallback={<Wrench size={size} />} />;
    }
    return <Icon size={size} />;
}

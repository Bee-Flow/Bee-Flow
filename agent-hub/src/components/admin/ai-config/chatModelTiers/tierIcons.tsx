import { Brain, Network, PenLine, Sparkles, Workflow, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TierDef } from './constants';

const TIER_GLYPHS: Record<string, LucideIcon> = {
    fast: Zap,
    standard: Workflow,
    swarm: Network,
    thinking: Brain,
    writer: PenLine,
    pro: Sparkles,
};

/** The small icon of a standard tier; the tier's own emoji only when its key has no glyph. */
export function TierGlyph({ tier }: { tier: Pick<TierDef, 'key' | 'icon'> }) {
    const Glyph = TIER_GLYPHS[tier.key];
    if (Glyph) return <Glyph className="h-4 w-4" />;
    return tier.icon ? <span className="text-sm leading-none">{tier.icon}</span> : null;
}

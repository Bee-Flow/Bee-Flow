import {
    Bot, ChevronRight, Clock, Database, Flag, GitBranch, Mail, MousePointer2, Pause, Plug, Repeat, ShieldCheck, Sparkles, Webhook, Zap,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import IntegrationLogo from '../../../automation/Builder/flow/nodes/IntegrationLogo';
import { StepIcon } from '../../../automation/Builder/flow/stepIcons';
import { flowSummaryOf, stripModelOf, type OverviewAutomation } from './overviewModel';

// The JS components declare `fallback` as null-only in JSDoc; they take any node.
type WithFallback = ComponentType<Record<string, unknown>>;
const Logo = IntegrationLogo as unknown as WithFallback;
const Icon = StepIcon as unknown as WithFallback;

type IconType = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

const TRIGGER_ICON: Record<string, IconType> = { schedule: Clock, manual: MousePointer2, webhook: Webhook, app_event: Mail, other: Bot };
const FAMILY_ICON: Record<string, IconType> = {
    trigger: Zap, ai: Sparkles, app: Plug, branch: GitBranch, loop: Repeat, data: Database, pause: Pause, guard: ShieldCheck, end: Flag,
};

interface Chip {
    key: string;
    type: string;
    family: string;
    kind?: string;
    provider?: string | null;
    icon?: string | null;
    app?: string | null;
    action?: string | null;
    label: string;
}

function Glyph({ chip, size }: { chip: Chip; size: number }) {
    if (chip.type === 'trigger') {
        const Fallback = TRIGGER_ICON[chip.kind || 'other'] || Bot;
        const fallback = <Fallback size={size} aria-hidden />;
        return chip.provider ? <Logo integrationId={chip.provider} size={size} fallback={fallback} /> : fallback;
    }
    const Fallback = FAMILY_ICON[chip.family] || Zap;
    const fallback = <Fallback size={size} aria-hidden />;
    if (chip.icon) return <Icon name={chip.icon} size={size} fallback={fallback} />;
    if (chip.type === 'integration_action' && (chip.app || chip.action)) {
        return <Logo integrationId={chip.app || undefined} tool={chip.action || undefined} size={size} fallback={fallback} />;
    }
    return fallback;
}

/**
 * "What is in it", in one row: the trigger and the first few steps as tiny
 * icon chips, in order, with a "+N" for the rest. Each chip names itself on
 * hover; the whole strip reads as one sentence to a screen reader.
 */
export default function StepStrip({ automation, small = false }: { automation: OverviewAutomation; small?: boolean }) {
    const { t } = useTranslation();
    const { chips, more, empty } = stripModelOf(automation, t) as { chips: Chip[]; more: number; empty: boolean };
    if (empty) {
        return <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="overview-step-strip">{t('studio_misc.overview.no_steps', 'No steps yet')}</span>;
    }
    const box = small ? 'h-5 w-5' : 'h-6 w-6';
    const px = small ? 12 : 13;
    return (
        <span
            role="img"
            aria-label={flowSummaryOf(automation, t)}
            data-testid="overview-step-strip"
            className="flex items-center gap-0.5 min-w-0 overflow-hidden"
        >
            {chips.map((chip, i) => (
                <span key={chip.key} className="inline-flex items-center gap-0.5 shrink-0">
                    {i > 0 && <ChevronRight size={10} aria-hidden className="text-[var(--text-tertiary)] opacity-60" />}
                    <span
                        title={chip.label}
                        data-testid="overview-step-chip"
                        className={`inline-flex ${box} items-center justify-center rounded-md bg-[var(--bg-secondary)] text-[var(--text-secondary)]`}
                    >
                        <Glyph chip={chip} size={px} />
                    </span>
                </span>
            ))}
            {more > 0 && (
                <span className="inline-flex items-center gap-0.5 shrink-0">
                    <ChevronRight size={10} aria-hidden className="text-[var(--text-tertiary)] opacity-60" />
                    <span className={`inline-flex ${box} min-w-6 px-1 items-center justify-center rounded-md bg-[var(--bg-secondary)] text-[10px] font-medium tabular-nums text-[var(--text-tertiary)]`} data-testid="overview-step-more">+{more}</span>
                </span>
            )}
        </span>
    );
}

// "Who does the thinking": two radio cards, a loose instruction or an agent.
import { Bot, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';

export type ThinkingMode = 'instruction' | 'agent';

interface ModeCardProps {
    selected: boolean;
    icon: ReactNode;
    title: string;
    description: string;
    onSelect: () => void;
}

function ModeCard({ selected, icon, title, description, onSelect }: ModeCardProps) {
    return (
        <button
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={onSelect}
            className={`flex items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                selected
                    ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_6%,transparent)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-card)] hover:bg-[var(--bg-secondary)]'}`}
        >
            <span
                aria-hidden="true"
                className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-2 ${selected ? 'border-[var(--accent-primary)]' : 'border-[var(--text-tertiary)]'}`}
            >
                {selected ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--accent-primary)]" /> : null}
            </span>
            <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
                    {icon}{title}
                </span>
                <span className="mt-0.5 block text-[11px] leading-[15px] text-[var(--text-secondary)]">{description}</span>
            </span>
        </button>
    );
}

export default function ThinkingModeCards({ mode, onChange, t }: { mode: ThinkingMode; onChange: (m: ThinkingMode) => void; t: TranslateFn }) {
    const label = t('routine_editor.agent_section_title', 'Who does the thinking');
    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-tertiary)]">{label}</div>
            <div role="radiogroup" aria-label={label} className="grid grid-cols-1 gap-2 @[420px]/aistep:grid-cols-2">
                <ModeCard
                    selected={mode === 'instruction'}
                    icon={<Sparkles size={13} className="text-[var(--type-ai)]" aria-hidden="true" />}
                    title={t('routines.agent_step.mode_instruction', 'Loose instruction')}
                    description={t('routines.agent_step.mode_instruction_desc', 'You write here what the AI should do. Only for this step.')}
                    onSelect={() => onChange('instruction')}
                />
                <ModeCard
                    selected={mode === 'agent'}
                    icon={<Bot size={13} className="text-[var(--type-ai)]" aria-hidden="true" />}
                    title={t('routines.agent_step.mode_agent', 'Use an agent')}
                    description={t('routines.agent_step.mode_agent_desc', 'An agent from Studio, with its role, knowledge and skills. One place to maintain.')}
                    onSelect={() => onChange('agent')}
                />
            </div>
        </div>
    );
}

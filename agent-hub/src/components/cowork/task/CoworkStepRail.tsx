import { Check } from 'lucide-react';
import { StepTile } from './CoworkTaskFlow';
import { stepWord, type TaskStep } from './coworkTaskModel';
import type { TranslateFn } from '@/hooks/useTranslation';

interface Props {
    steps: TaskStep[]; selected?: string[]; toggle?: (id: string) => void; active?: string;
    disabled?: boolean; t: TranslateFn;
}

export default function CoworkStepRail({ steps, selected = [], toggle, active, disabled, t }: Props) {
    if (!steps.length) return null;
    return <aside className="cowork-step-rail" aria-label={t('cowork_task.steps.heading', 'Steps')}>
        <h2>{t('cowork_task.steps.heading', 'Steps')}</h2>
        <ol>{steps.map(step => {
            const picked = selected.includes(step.id);
            const detail = step.id === active ? t('cowork_task.orb.active', 'In progress') : step.description || [stepWord(step, t), step.app].filter(Boolean).join(' · ');
            return <li key={step.id} aria-current={step.id === active ? 'step' : undefined}>
                <button type="button" aria-pressed={picked} disabled={disabled || !toggle} onClick={() => toggle?.(step.id)}>
                    <StepTile step={step} />
                    <span className="min-w-0"><strong>{step.title}</strong><small>{detail}</small></span>
                    {picked && <Check size={15} aria-hidden="true" />}
                </button>
            </li>;
        })}</ol>
    </aside>;
}

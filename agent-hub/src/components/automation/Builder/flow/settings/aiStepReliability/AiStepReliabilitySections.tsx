// The AI step's reliability settings, in the two places the editor shows them:
// the Advanced rows (temperature, reuse of the answer) and the Answer checks
// section. aiStepEditors.jsx renders these and nothing else of this folder.
import { useTranslation } from '@/hooks/useTranslation';
import { AskOnceRow } from '../actionEditors/askOnceRow';
import type { FormRecord } from '../formState/types';
import { TemperatureField } from './TemperatureField';
import { mayUseTools } from './reliabilityModel';

export { ConcurrencyField } from './ConcurrencyField';

interface Props {
    draft: FormRecord;
    set: (key: string, value: unknown) => void;
}

/** Temperature and "reuse the answer", for the Advanced section. */
export function AiStepAdvancedRows({ draft, set }: Props) {
    const { t } = useTranslation();
    const tools = mayUseTools(draft);
    return (
        <>
            <TemperatureField value={typeof draft.temperature === 'number' ? draft.temperature : null} onChange={(next) => set('temperature', next)} />
            <AskOnceRow
                draft={draft}
                set={set}
                // A step that is already on can always be switched off.
                disabled={tools && !draft.askOnce}
                disabledReason={tools ? t('ai_step_checks.reuse_tools', 'The answer is not reused while the step can use tools, because a tool may change something. Turn the tools off to reuse the answer.') : null}
                label={t('ai_step_checks.reuse_label', 'Reuse the answer when the input is the same')}
                description={t('ai_step_checks.reuse_hint', 'When this step asks the AI exactly the same thing again in a run, for example for repeated rows, the first answer is used instead of asking again. Faster and cheaper. It only applies when the whole prompt, after privacy protection, is the same.')}
                acrossRunsLabel={t('ai_step_checks.reuse_across', '…and keep the answer for later runs too')}
                acrossRunsDescription={t('ai_step_checks.reuse_across_hint', 'The answer is stored, encrypted, so a later run can use it. This needs the organisation setting "Answers from AI steps" to be on, and your administrator decides for how long; until then this step asks the AI every run. Test runs never use stored answers.')}
            />
        </>
    );
}

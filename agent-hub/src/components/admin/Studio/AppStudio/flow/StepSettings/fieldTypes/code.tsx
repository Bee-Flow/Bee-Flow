import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import CodeEditorField from '@/components/automation/Builder/flow/settings/codeStep/CodeEditorField';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

/** server/appStudio/componentSpecs/limits.js MAX_CODE_STEP_CHARS (the spec's maxLen wins when it says one). */
const MAX_CHARS = 20000;

const inputNames = (inputs: unknown): string[] =>
    (inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? Object.keys(inputs) : []);

/**
 * `code`: the JavaScript of an app code step, in the code editor the automation code step uses
 * (Monaco, or a plain box the person can choose). Above it the contract in one line, below it the
 * names the code can read (the step's `inputs`, edited in the field after this one) and how close
 * the source is to its length limit. An empty box writes undefined, so the required-field check
 * names it instead of a blank string passing for code.
 */
function CodeControl({ label, value, onChange, step, fs, disabled }: StepFieldControlProps) {
    const { t } = useTranslation();
    const source = typeof value === 'string' ? value : '';
    const max = typeof fs.maxLen === 'number' ? fs.maxLen : MAX_CHARS;
    const names = inputNames(step?.inputs);
    const over = source.length > max;
    return (
        <FormField
            label={label}
            description={t('studio_apps_step_code.field.contract', 'Write function main(inputs, ctx) and return a value: it lands in vars.<result variable>. ctx.log(…) notes a line. There is no network, no database and no integrations; write with a step after this one.')}
            hint={over
                ? t('studio_apps_step_code.field.too_long', '{count} of at most {max} characters: shorten the code.', { count: source.length, max })
                : t('studio_apps_step_code.field.length', '{count} of {max} characters.', { count: source.length, max })}
        >
            <div data-step-control="code" className={disabled ? 'pointer-events-none opacity-60' : undefined}>
                <CodeEditorField value={source} onChange={(next) => onChange(next === '' ? undefined : next)} />
            </div>
            <p className="mt-1.5 text-[11px] text-[var(--text-secondary)]" data-step-control="code.inputs">
                {names.length
                    ? t('studio_apps_step_code.field.inputs', 'Your code reads: {names}', { names: names.map((n) => `inputs.${n}`).join(', ') })
                    : t('studio_apps_step_code.field.no_inputs', 'No inputs yet: add them under Inputs, each a value, a formula or rows of a table.')}
            </p>
        </FormField>
    );
}

const entry: StepFieldTypeModule = { type: 'code', Control: CodeControl };
export default entry;

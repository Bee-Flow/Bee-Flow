import FormField from '@/components/shared/FormField';
import { NumberInput } from '@/components/admin/Studio/AppStudio/inspector/AiChecksField';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

/**
 * `number`: a decimal (an AI step's temperature, 0 to 2). Blank writes nothing, so the step keeps
 * the model tier's own setting and a definition that never set it stays as it was.
 */
function NumberControl({ label, hint, fs, value, onChange, disabled }: StepFieldControlProps) {
    return (
        <FormField label={label} hint={hint}>
            <NumberInput
                value={value}
                onChange={onChange}
                min={typeof fs.min === 'number' ? fs.min : undefined}
                max={typeof fs.max === 'number' ? fs.max : undefined}
                step={0.1}
                ariaLabel={label}
                disabled={disabled}
            />
        </FormField>
    );
}

const entry: StepFieldTypeModule = { type: 'number', Control: NumberControl };
export default entry;

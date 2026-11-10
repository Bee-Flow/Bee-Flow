import AiChecksField from '@/components/admin/Studio/AppStudio/inspector/AiChecksField';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

/**
 * `aiChecks`: the answer checks of an AI step in a sequence, the same editor as the bare
 * ai_generate / ai_extract action's. An empty list writes nothing.
 */
function AiChecksControl({ value, onChange, disabled }: StepFieldControlProps) {
    return <AiChecksField value={value} onChange={onChange} disabled={disabled} />;
}

const entry: StepFieldTypeModule = { type: 'aiChecks', Control: AiChecksControl };
export default entry;

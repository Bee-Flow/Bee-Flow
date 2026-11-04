import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';

interface ErrorHandlerFieldProps {
    label: string;
    value: unknown;
    onChange: (next: unknown) => void;
    disabled?: boolean;
}

type Mode = 'stop' | 'continue' | 'fallback_stop';
type Handler = { steps: unknown[]; stop?: boolean };

const asHandler = (v: unknown): Handler | null => (v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as { steps?: unknown }).steps)
    ? v as Handler : null);

/**
 * What happens when the step fails. This field only chooses the BEHAVIOUR:
 *   - stop and show the reason (no handler, as before);
 *   - run the "If it fails" steps, then carry on;
 *   - run the "If it fails" steps, then stop.
 * The fallback steps themselves are drawn and edited on the canvas, in the
 * step's "If it fails" branch; switching between the last two keeps them.
 */
export default function ErrorHandlerField({ label, value, onChange, disabled = false }: ErrorHandlerFieldProps) {
    const { t } = useTranslation();
    const handler = asHandler(value);
    const mode: Mode = !handler ? 'stop' : handler.stop ? 'fallback_stop' : 'continue';

    const choose = (next: string) => {
        if (next === 'stop') { onChange(undefined); return; }
        const steps = handler ? handler.steps : [];
        onChange(next === 'fallback_stop' ? { steps, stop: true } : { steps });
    };

    return (
        <FormField label={label}>
            <div className="flex flex-col gap-1.5" data-error-handler={mode}>
                <SegmentedControl
                    value={mode}
                    onChange={choose}
                    options={[
                        { value: 'stop', label: t('studio_apps_edit.step_settings.on_error_stop', 'Stop and show why') },
                        { value: 'continue', label: t('studio_apps_edit.step_settings.on_error_continue', 'Fallback, then go on') },
                        { value: 'fallback_stop', label: t('studio_apps_edit.step_settings.on_error_fallback_stop', 'Fallback, then stop') },
                    ]}
                    size="sm"
                    disabled={disabled}
                    ariaLabel={label}
                />
                <span className="text-[11px] text-[var(--text-secondary)]">
                    {mode === 'stop'
                        ? t('studio_apps_edit.step_settings.on_error_stop_help', 'The action stops here and shows the reason the step failed.')
                        : t('studio_apps_edit.step_settings.on_error_steps_help', 'Add the fallback steps in the "If it fails" branch on the canvas. They can read error.message and error.step.')}
                </span>
            </div>
        </FormField>
    );
}

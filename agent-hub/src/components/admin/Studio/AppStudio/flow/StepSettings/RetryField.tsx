import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import { STEP_RETRY } from '@shared/appDefinition/stepFlow.mjs';
import { INPUT_CLS } from '../../inspector/panels/kit';

interface RetryFieldProps {
    label: string;
    value: unknown;
    onChange: (next: unknown) => void;
    disabled?: boolean;
}

type Retry = { times?: unknown; delayMs?: unknown };

const asRetry = (v: unknown): Retry => (v && typeof v === 'object' && !Array.isArray(v) ? v as Retry : {});
const toInt = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback);

/**
 * `retry` on a server step: how often to try again when it fails in a way a
 * retry can help (a busy database, a provider hiccup), and how long to wait in
 * between. 0 tries = no retry (the field is removed).
 */
export default function RetryField({ label, value, onChange, disabled = false }: RetryFieldProps) {
    const { t } = useTranslation();
    const retry = asRetry(value);
    const times = Math.min(STEP_RETRY.MAX_TIMES, Math.max(0, toInt(retry.times, 0)));
    const seconds = toInt(retry.delayMs, STEP_RETRY.DEFAULT_DELAY_MS) / 1000;

    const setTimes = (n: number) => onChange(n > 0 ? { ...retry, times: n } : undefined);
    const setSeconds = (s: number) => onChange({ ...retry, times, delayMs: Math.round(Math.min(STEP_RETRY.MAX_DELAY_MS / 1000, Math.max(0, s)) * 1000) });

    return (
        <FormField
            label={label}
            hint={t('studio_apps_edit.step_settings.retry_hint', 'Only failures a retry can help (a busy database, a temporary problem at the AI provider) are tried again.')}
        >
            <div className="flex items-center gap-2" data-retry-field>
                <select
                    className={INPUT_CLS}
                    value={times}
                    onChange={(e) => setTimes(Number(e.target.value))}
                    disabled={disabled}
                    aria-label={t('studio_apps_edit.step_settings.retry_times', 'Times to try again')}
                >
                    {Array.from({ length: STEP_RETRY.MAX_TIMES + 1 }, (_, n) => (
                        <option key={n} value={n}>
                            {n === 0
                                ? t('studio_apps_edit.step_settings.retry_none', 'Do not try again')
                                : t('studio_apps_edit.step_settings.retry_n', 'Try again up to {n} times', { n })}
                        </option>
                    ))}
                </select>
                {times > 0 ? (
                    <input
                        type="number"
                        className={INPUT_CLS}
                        min={0}
                        max={STEP_RETRY.MAX_DELAY_MS / 1000}
                        step={0.5}
                        value={seconds}
                        onChange={(e) => setSeconds(Number(e.target.value))}
                        disabled={disabled}
                        aria-label={t('studio_apps_edit.step_settings.retry_wait', 'Seconds to wait in between')}
                    />
                ) : null}
            </div>
        </FormField>
    );
}

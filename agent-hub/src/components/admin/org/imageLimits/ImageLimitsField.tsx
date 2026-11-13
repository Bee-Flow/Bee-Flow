import { useId } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { IMAGE_LIMIT_WINDOWS, MAX_IMAGE_LIMIT } from '@/utils/imageLimits';
import type { ImageLimitWindow, ImageLimitsInput } from '@/utils/imageLimits';

/** The label key and English text of each window's input. */
const WINDOW_LABELS: Record<ImageLimitWindow, { key: string; en: string }> = {
    hour: { key: 'image_limits.window_hour', en: 'Per hour' },
    day: { key: 'image_limits.window_day', en: 'Per 24 hours' },
    week: { key: 'image_limits.window_week', en: 'Per 7 days' },
    month: { key: 'image_limits.window_month', en: 'Per 30 days' },
};

interface ImageLimitsFieldProps {
    value: ImageLimitsInput;
    onChange: (next: ImageLimitsInput) => void;
    /** The heading of the four inputs. */
    label: string;
    /** What this level means (who it applies to, what an empty window does). */
    hint?: string;
    /** Smaller text, for the inline editors of the organisation panel. */
    compact?: boolean;
}

/**
 * Four small whole-number inputs, one per rolling window. Empty is "not set"
 * (the next level decides), 0 is "no limit". The parent keeps the texts and
 * turns them into the request value with parseImageLimitsInput.
 */
export default function ImageLimitsField({ value, onChange, label, hint, compact = false }: ImageLimitsFieldProps) {
    const { t } = useTranslation();
    const baseId = useId();
    const notSet = t('image_limits.not_set', 'Not set');
    const inputClass = compact
        ? 'w-full px-2 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-xs outline-none focus:border-[var(--accent-primary)]'
        : 'w-full px-3 py-2 rounded-lg border bg-transparent outline-none focus:border-[var(--accent-primary)] border-[var(--border-default)] text-[var(--text-primary)]';
    return (
        <fieldset>
            <legend className={compact ? 'text-xs text-[var(--text-secondary)] mb-1' : 'block text-sm font-medium mb-1 text-[var(--text-primary)]'}>{label}</legend>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {IMAGE_LIMIT_WINDOWS.map(window => {
                    const id = `${baseId}-${window}`;
                    return (
                        <div key={window} className="min-w-0">
                            <label htmlFor={id} className="block text-[11px] mb-0.5 text-[var(--text-muted)]">{t(WINDOW_LABELS[window].key, WINDOW_LABELS[window].en)}</label>
                            <input
                                id={id}
                                type="number"
                                min="0"
                                max={MAX_IMAGE_LIMIT}
                                step="1"
                                inputMode="numeric"
                                value={value[window]}
                                onChange={e => onChange({ ...value, [window]: e.target.value })}
                                placeholder={notSet}
                                className={inputClass}
                            />
                        </div>
                    );
                })}
            </div>
            <p className={`${compact ? 'text-[10px]' : 'text-xs'} mt-1 text-[var(--text-muted)]`}>
                {hint ? `${hint} ` : ''}{t('image_limits.rules_hint', 'Empty: not set. 0: no limit.')}
            </p>
        </fieldset>
    );
}

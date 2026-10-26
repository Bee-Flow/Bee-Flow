import { useState, type ChangeEvent } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import AccordionSection from '../../AccordionSection';
import { WAIT_UNIT_FACTOR, clampWaitSeconds, waitUnitFor, type WaitUnit } from '../../waitDuration';
import { controlSurfaceClass, FormRow } from '../formPrimitives';
import type { WaitFieldsProps } from '../collectionEditors.types';

// Moved to flow/waitDuration.js so the canvas card renders the SAME unit this
// editor opens on — the node used to print "7200s" for a Wait set to 2 hours.
export function WaitFields({ draft, set, errorSections = new Set() }: WaitFieldsProps) {
    const { t } = useTranslation();
    const seconds = clampWaitSeconds(Number(draft.seconds ?? 5) || 5);
    // Display unit is derived ONCE on mount and held locally — switching the
    // unit only re-interprets the display; the stored value stays `seconds`
    // and is never re-emitted on mount (no autosave churn on open).
    const [unit, setUnit] = useState(() => waitUnitFor(seconds));
    const factor = WAIT_UNIT_FACTOR[unit] || 1;
    // While the field is being edited the user's raw text wins. Clamping on
    // every keystroke made the field unusable: emptying it gives
    // `Number('') === 0` — not NaN, so the old guard never fired — and
    // `Math.max(1, 0)` snapped it straight back to 1, so you could never
    // clear-and-retype (BFSF-345).
    const [typed, setTyped] = useState<string | null>(null);
    const display = typed ?? String(Math.round((seconds / factor) * 100) / 100);

    const commit = (raw: string) => {
        const n = Number(raw);
        if (raw == null || String(raw).trim() === '' || !Number.isFinite(n) || n <= 0) return false;
        set('seconds', clampWaitSeconds(n * factor));
        return true;
    };
    const onValue = (e: ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
        setTyped(e.target.value);
        commit(e.target.value);
    };
    // Dropping the raw text on blur is what restores the last stored value
    // when the field was left empty or nonsense.
    const onBlur = () => { setTyped(null); };
    // Switching the unit keeps the number the user is looking at and
    // re-interprets it (5 seconds → 5 minutes), instead of rescaling it into
    // a rounded-to-zero 0.08 that sits below the field's own minimum.
    const onUnit = (e: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
        const next = e.target.value as WaitUnit;
        const n = Number(display);
        setUnit(next);
        setTyped(null);
        if (Number.isFinite(n) && n > 0) set('seconds', clampWaitSeconds(n * (WAIT_UNIT_FACTOR[next] || 1)));
    };

    // `inputClass()` bakes in `w-full`; adding `w-auto` next to it leaves two
    // utilities racing for one property (won by stylesheet order, not class
    // order — see formStyles.js), which let the unit select eat the whole row
    // and collapsed the number field to its spinner. Both controls carry
    // their own width instead.
    const controlSize = 'px-2 py-1.5 text-sm';
    return (
        <AccordionSection stepType="wait" sectionKey="config" title={t('automations.collection_editors.configuration', 'Configuration')} defaultOpen forceOpen={errorSections.has('config')}>
            <FormRow label={t('automations.collection_editors.wait_for', 'Wait for')} required hint={t('automations.collection_editors.up_to_24_hours_dry_run', 'Up to 24 hours. Dry-run skips the wait.')}>
                <div className="flex items-stretch gap-1.5">
                    <input
                        type="number"
                        min={unit === 'seconds' ? 1 : 0.01}
                        step={unit === 'seconds' ? 1 : 'any'}
                        value={display}
                        onChange={onValue}
                        onBlur={onBlur}
                        aria-label={t('automations.collection_editors.wait_duration', 'Wait duration')}
                        className={controlSurfaceClass(`flex-1 min-w-[5rem] ${controlSize}`)}
                    />
                    <select
                        value={unit}
                        onChange={onUnit}
                        className={controlSurfaceClass(`w-auto shrink-0 ${controlSize}`)}
                        aria-label={t('automations.collection_editors.duration_unit', 'Duration unit')}
                    >
                        <option value="seconds">{t('automations.collection_editors.seconds', 'seconds')}</option>
                        <option value="minutes">{t('automations.collection_editors.minutes', 'minutes')}</option>
                        <option value="hours">{t('automations.collection_editors.hours', 'hours')}</option>
                    </select>
                </div>
            </FormRow>
        </AccordionSection>
    );
}

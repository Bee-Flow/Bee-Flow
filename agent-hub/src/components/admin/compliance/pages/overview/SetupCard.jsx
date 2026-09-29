import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Check, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { TONES } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import SetupStepBody, {
    LEGAL_BASES, SETUP_STEPS, SETUP_STEP_COUNT,
    applyAutoDetect, canProceed, firstOpenStep, initialSetupData, setupBody, stepIsComplete,
} from '../../setup/SetupSteps';

/**
 * SetupCard — the ONE not-set-up path (artboard 1g, PLAN-FRONTEND C13).
 *
 * No banner, no hero, no modal: the four steps live inline at the top of the
 * Overview, pre-filled from `onAutoDetect()` and saved in one call to
 * `onFinish(setupBody(data))`. Auto-detect never overwrites a setting the org
 * already saved (that rule lives in `applyAutoDetect`), and a failing
 * auto-detect endpoint is invisible — the card still works, just without the
 * "from your configuration" hints.
 *
 *   settings        core.settings (the saved compliance settings, may be null)
 *   orgUsers        [] | null — the directory for the DPO / recipient pickers
 *   onAutoDetect()  core.autoDetect — POST /auto-detect-settings
 *   onFinish(body)  core.finishSetup
 *   onStepChange(n) reports the 1-based active step (the header pill)
 */
export default function SetupCard({
    settings = null, orgUsers = null, onAutoDetect, onFinish, onStepChange,
    className = '', testId = 'setup-card',
}) {
    const { t } = useTranslation();
    const [data, setData] = useState(() => initialSetupData(settings));
    const [detectedFields, setDetectedFields] = useState([]);
    const [active, setActive] = useState(() => Math.min(firstOpenStep(initialSetupData(settings)), SETUP_STEP_COUNT - 1));
    const [open, setOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const detectRan = useRef(false);
    const reported = useRef(null);

    // Pre-fill once. A 5xx here is not an error the user needs to see: the four
    // fields are still editable, they are simply empty.
    const applyDetected = useEffectEvent((detected) => {
        const { patch, hit } = applyAutoDetect(detected, settings);
        if (hit.length) {
            setData(prev => ({ ...prev, ...patch }));
            setDetectedFields(hit);
            setActive(prev => (prev === 0 && !canProceed(0, { ...data, ...patch }) ? 0 : prev));
        }
    });
    useEffect(() => {
        if (detectRan.current || typeof onAutoDetect !== 'function') return;
        detectRan.current = true;
        let alive = true;
        Promise.resolve()
            .then(() => onAutoDetect())
            .then((detected) => { if (alive) applyDetected(detected); })
            .catch(() => { /* the card works without the pre-fill */ });
        return () => { alive = false; };
    }, [onAutoDetect]);

    // The header shows "Setup · step n of 4"; the page forwards this upward.
    useEffect(() => {
        const step = active + 1;
        if (reported.current === step) return;
        reported.current = step;
        onStepChange?.(step);
    }, [active, onStepChange]);

    const update = (patch) => setData(prev => ({ ...prev, ...patch }));
    const detected = useMemo(() => new Set(detectedFields), [detectedFields]);
    const ready = canProceed(active, data);
    const last = active === SETUP_STEP_COUNT - 1;

    const openStep = (index) => { setActive(index); setOpen(true); };

    const advance = async () => {
        if (!ready) return;
        if (!last) { setActive(active + 1); return; }
        setSaving(true);
        try { await onFinish?.(setupBody(data)); }
        catch { /* the hook toasts; the card stays open so nothing is lost */ }
        finally { setSaving(false); }
    };

    return (
        <section
            className={`flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3.5 ${className}`}
            style={{ boxShadow: 'var(--shadow-sm)' }}
            data-testid={testId}
            data-step={active + 1}
            aria-label={t('compliance.setup_title', 'Setup — two minutes, four steps')}
        >
            <header className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                    <h2 className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">
                        {t('compliance.setup_title', 'Setup — two minutes, four steps')}
                    </h2>
                    <p className="m-0 mt-1 text-xs text-[var(--text-secondary)]">
                        {t('compliance.setup_lead', 'Pre-filled from your configuration — check it and adjust. The first scan runs straight after.')}
                    </p>
                </div>
                {!open ? (
                    <button
                        type="button"
                        onClick={() => setOpen(true)}
                        className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 text-[12px] font-semibold"
                        style={PRIMARY_ACTION_STYLE}
                        data-testid={`${testId}-cta`}
                    >
                        {t('compliance.setup_continue', 'Continue with step {n}', { n: active + 1 })}
                        <ChevronRight size={13} aria-hidden />
                    </button>
                ) : null}
            </header>

            <ol
                className="m-0 grid list-none grid-cols-4 gap-2 p-0 @max-[1180px]/cpage:grid-cols-2"
                data-testid={`${testId}-tiles`}
            >
                {SETUP_STEPS.map((step, index) => {
                    const done = stepIsComplete(index, data) && index !== active;
                    const isActive = index === active;
                    return (
                        <li key={step.key}>
                            <button
                                type="button"
                                onClick={() => openStep(index)}
                                aria-current={isActive ? 'step' : undefined}
                                data-testid={`${testId}-tile-${step.key}`}
                                data-state={done ? 'done' : isActive ? 'active' : 'pending'}
                                className={`flex w-full flex-col gap-1.5 rounded-[10px] px-3 py-2.5 text-left ${isActive
                                    ? 'border-2 border-[var(--text-primary)]'
                                    : 'border border-[var(--border-default)] hover:bg-[var(--bg-secondary)]'}`}
                            >
                                <span className="flex items-center gap-2">
                                    <StepDisc index={index} done={done} active={isActive} />
                                    <span className="truncate text-xs font-semibold text-[var(--text-primary)]">
                                        {t(step.titleKey)}
                                    </span>
                                </span>
                                <span className="text-[11px] leading-snug text-[var(--text-tertiary)]" data-testid={`${testId}-tile-value`}>
                                    {tileValue(index, data, detected, t)}
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ol>

            {open ? (
                <div className="flex flex-col gap-3 border-t border-[var(--border-default)] pt-3" data-testid={`${testId}-body`}>
                    <SetupStepBody step={active} data={data} onChange={update} orgUsers={orgUsers} />
                    <div className="flex flex-wrap items-center gap-2">
                        {active > 0 ? (
                            <button
                                type="button"
                                onClick={() => setActive(active - 1)}
                                className="inline-flex h-8 items-center rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-3 text-[12px] font-medium text-[var(--text-primary)]"
                                data-testid={`${testId}-back`}
                            >
                                {t('compliance.back', 'Back')}
                            </button>
                        ) : null}
                        <button
                            type="button"
                            onClick={advance}
                            disabled={!ready || saving}
                            className="inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                            style={PRIMARY_ACTION_STYLE}
                            data-testid={`${testId}-next`}
                        >
                            {saving ? <Loader2 size={13} className="animate-spin" aria-hidden /> : null}
                            {last
                                ? t('compliance.setup_finish', 'Finish setup and run the first scan')
                                : t('compliance.next', 'Next')}
                        </button>
                        {!ready ? (
                            <span className="text-[11px]" style={{ color: TONES.warning.ink }} data-testid={`${testId}-blocked`}>
                                {active === 0
                                    ? t('compliance.setup_need_dpo', 'A name and an e-mail address are needed to continue.')
                                    : t('compliance.setup_need_legal', 'Pick at least one legal basis.')}
                            </span>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </section>
    );
}

function StepDisc({ index, done, active }) {
    if (done) {
        return (
            <span
                className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full"
                style={{ background: `color-mix(in srgb, ${TONES.success.raw} 16%, transparent)`, color: TONES.success.ink }}
                aria-hidden
            >
                <Check size={12} />
            </span>
        );
    }
    return (
        <span
            className={`inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${active ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]'}`}
            style={{ border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border-default)'}` }}
            aria-hidden
        >
            {index + 1}
        </span>
    );
}

/** The "pre-filled value" line under a tile — the fact, plus where it came from. */
export function tileValue(index, data, detected, t) {
    const from = (field, text) => (detected?.has?.(field)
        ? t('compliance.setup_from_config', '{value} · from your configuration', { value: text })
        : text);
    if (index === 0) {
        if (!data?.dpo_name && !data?.dpo_email) return t('compliance.setup_hint_dpo', 'who answers a data-subject request');
        return from('dpo_name', [data.dpo_name, data.dpo_email].filter(Boolean).join(' · '));
    }
    if (index === 1) {
        const bases = Array.isArray(data?.legal_bases) ? data.legal_bases : [];
        if (!bases.length) return t('compliance.setup_hint_legal', 'why you may process personal data');
        const names = bases.map(id => {
            const lb = LEGAL_BASES.find(b => b.id === id);
            return lb ? t(lb.labelKey) : id;
        }).join(', ');
        return detected?.has?.('legal_bases')
            ? t('compliance.setup_suggested', 'suggested: {values}', { values: names })
            : names;
    }
    if (index === 2) {
        const residency = t(`compliance.residency_${data?.data_residency || 'eu'}`);
        const days = data?.default_retention_days;
        const text = days != null && days !== ''
            ? t('compliance.setup_residency_value', '{residency} · {days} days', { residency, days })
            : residency;
        return from('data_residency', text);
    }
    const recipients = Array.isArray(data?.breach_recipients) ? data.breach_recipients : [];
    if (!recipients.length) return t('compliance.setup_hint_breach', 'who gets to see the 72-hour clock');
    return from('breach_recipients', t('compliance.setup_recipients_value', '{n} recipients', { n: recipients.length }));
}

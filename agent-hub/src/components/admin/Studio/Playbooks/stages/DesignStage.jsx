import { LayoutTemplate, Loader2, PenTool, Wand2 } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import StageShell from './StageShell';
import { isBusy, panelCard, STAGE_BUTTON, stageType } from './stageChrome';
import { revealSchedule } from '../../../../shared/builder/revealSchedule';
import { TONES } from '../../../../shared/statusTone';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';

const SCREEN_STAGGER_MS = 450;
const EMPTY = Object.freeze([]);

/**
 * The DESIGN phase on stage: the designer's answer drawn as wireframes —
 * one card per screen, its sections and elements sketched in the design's
 * accent, arriving one screen at a time (revealSchedule). Nothing here is
 * the real app; it is what the app builder is about to be told to build.
 *
 * Once it has landed the person can ASK FOR SOMETHING ELSE: a sentence goes
 * to the designer with the design that stands, the whole thing is redrawn
 * here, and the app phase's brief is recomposed around the new one — so what
 * the builder gets is always the design on screen.
 */
export default function DesignStage({ phase, dispatch, t, reducedMotion = false, presenter = false }) {
    const status = phase?.status;
    const art = phase?.artifacts || {};
    const design = art.design || null;
    const startedRef = useRef(null);
    useEffect(() => {
        if (status !== 'ready') return;
        const stamp = `${phase.key}:${phase.attempt || 0}`;
        if (startedRef.current === stamp) return;
        startedRef.current = stamp;
        dispatch({ type: 'start', key: phase.key });
    }, [status, phase, dispatch]);

    // Asking for a change: the same phase redraws, so nothing moves in the
    // rail — only this stage shows that the designer is at work again.
    const [feedback, setFeedback] = useState('');
    const [revising, setRevising] = useState(false);
    const [reviseError, setReviseError] = useState(false);
    const askForChange = useCallback(async () => {
        const text = feedback.trim();
        if (!text || revising) return;
        setRevising(true);
        setReviseError(false);
        const pb = await dispatch({ type: 'revise', key: phase.key, feedback: text });
        setRevising(false);
        if (pb) setFeedback(''); else setReviseError(true);
    }, [feedback, revising, dispatch, phase]);

    const screens = design && Array.isArray(design.screens) ? design.screens : EMPTY;
    // Memoised, and keyed on the revision count, so asking for a change DEALS
    // the wireframes in again instead of mutating them silently in place — the
    // one moment built to show the AI answering the room.
    const revision = Array.isArray(art.revisions) ? art.revisions.length : 0;
    const schedule = useMemo(
        () => revealSchedule(screens.map((_, i) => `s${i}`), { stagger: SCREEN_STAGGER_MS }),
        [screens],
    );
    const accent = (design && design.look && design.look.accent) || 'var(--kind-app)';
    const failed = status === 'failed';
    const type = stageType(presenter);

    return (
        <StageShell
            kind="app"
            icon={PenTool}
            width="wide"
            presenter={presenter}
            testId="playbook-stage-design"
            phaseKey={phase?.key}
            title={design ? design.name : t('playbooks.design.title', 'Designing the app')}
            subtitle={design && design.tagline ? design.tagline : null}
            tone={failed ? 'error' : 'busy'}
            status={design
                ? null
                : (
                    <>
                        {isBusy(status) && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                        {failed
                            ? t('playbooks.design.failed', 'The designer did not answer')
                            : t('playbooks.design.thinking', 'The AI thinks about this app as a designer first — screens, hierarchy, one accent — before it knows a single building block.')}
                    </>
                )}
        >
                {design && (
                    <div className="flex flex-wrap items-center gap-2" style={{ fontSize: type.meta, color: 'var(--text-secondary)' }} data-testid="playbook-design-look">
                        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full" style={{ border: '1px solid var(--border-default)' }}>
                            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 999, background: accent }} />
                            {t('playbooks.design.look_words', 'Look {preset}{mood}', { preset: design.look.preset, mood: design.look.mood ? ` · ${design.look.mood}` : '' })}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{t('playbooks.design.counts', '{screens} screens · {elements} elements', { screens: screens.length, elements: art.elementCount || 0 })}</span>
                    </div>
                )}

                {screens.length > 0 && (
                    <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${presenter ? 320 : 280}px, 1fr))` }} data-testid="playbook-design-screens">
                        {screens.map((s, i) => {
                            const slot = schedule.get(`s${i}`);
                            return (
                                <article
                                    key={`${revision}:${s.name}-${i}`}
                                    className={reducedMotion ? '' : 'pbk-col-in'}
                                    style={{ '--pbk-delay': `${slot ? slot.delayMs : 0}ms`, ...panelCard(presenter), padding: 0, boxShadow: 'var(--shadow-md)', overflow: 'hidden' }}
                                    data-testid="playbook-design-screen"
                                >
                                    <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid var(--border-default)', background: 'var(--bg-primary)' }}>
                                        <span className="flex gap-1" aria-hidden="true">
                                            {[0, 1, 2].map((k) => <span key={k} style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--border-default)' }} />)}
                                        </span>
                                        <span className="font-semibold truncate" style={{ fontSize: type.body, color: 'var(--text-primary)' }}>{s.name}</span>
                                    </div>
                                    <div className="p-3 space-y-3">
                                        {s.purpose && <p style={{ fontSize: type.meta, color: 'var(--text-secondary)' }}>{s.purpose}</p>}
                                        {s.sections.map((sec, j) => <Section key={j} section={sec} accent={accent} type={type} />)}
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                )}

                {design && status === 'awaiting' && (
                    <section className="mt-5 rounded-xl p-3" style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)' }} data-testid="playbook-design-revise">
                        <div className="flex items-center gap-2 mb-1.5">
                            <Wand2 className="w-3.5 h-3.5" style={{ color: 'var(--type-ai)' }} aria-hidden="true" />
                            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{t('playbooks.design.revise_label', 'Ask for a change')}</span>
                        </div>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <textarea
                                value={feedback}
                                onChange={(e) => setFeedback(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) askForChange(); }}
                                rows={2}
                                maxLength={800}
                                disabled={revising}
                                placeholder={t('playbooks.design.revise_placeholder', 'Put the totals on top, give every supplier its own screen…')}
                                className="flex-1 min-w-0 rounded-lg px-2.5 py-2 text-xs resize-y"
                                style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' }}
                                data-testid="playbook-design-revise-input"
                                aria-label={t('playbooks.design.revise_label', 'Ask for a change')}
                            />
                            <button
                                type="button"
                                onClick={askForChange}
                                disabled={revising || !feedback.trim()}
                                className={`shrink-0 self-start ${STAGE_BUTTON}`}
                                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                                data-testid="playbook-design-revise-send"
                            >
                                {revising
                                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{t('playbooks.design.revising', 'Redrawing…')}</>
                                    : t('playbooks.design.revise_send', 'Redraw')}
                            </button>
                        </div>
                        <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>{t('playbooks.design.revise_hint', 'The design is redrawn with your change — the app is built from what stands here.')}</p>
                        {reviseError && <p role="alert" className="mt-1" style={{ fontSize: type.meta, color: TONES.error.ink }}>{t('playbooks.design.revise_failed', 'The designer could not redraw it — try saying it in other words.')}</p>}
                        {Array.isArray(art.revisions) && art.revisions.length > 0 && (
                            <p className="mt-1.5 text-[11px]" style={{ color: 'var(--text-secondary)' }} data-testid="playbook-design-revisions">
                                {t('playbooks.design.revisions', 'You asked for: {list}', { list: art.revisions.join(' · ') })}
                            </p>
                        )}
                    </section>
                )}

                {design && Array.isArray(design.principles) && design.principles.length > 0 && (
                    <ul className="mt-5 flex flex-wrap gap-2" data-testid="playbook-design-principles">
                        {design.principles.map((p, i) => (
                            <li key={i} className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}>
                                <LayoutTemplate className="w-3 h-3" aria-hidden="true" />{p}
                            </li>
                        ))}
                    </ul>
                )}
        </StageShell>
    );
}

const LAYOUT_STYLE = {
    row: { display: 'flex', gap: 8, flexWrap: 'wrap' },
    grid: { display: 'grid', gap: 8, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
    split: { display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' },
    stack: { display: 'flex', flexDirection: 'column', gap: 8 },
};

function Section({ section, accent, type }) {
    return (
        <section>
            {section.title && <div className="font-semibold uppercase tracking-wide mb-1.5" style={{ fontSize: type.micro, color: 'var(--text-tertiary)' }}>{section.title}</div>}
            <div style={LAYOUT_STYLE[section.layout] || LAYOUT_STYLE.stack}>
                {section.elements.map((e, i) => <Element key={i} element={e} accent={accent} type={type} grow={section.layout === 'row'} />)}
            </div>
        </section>
    );
}

/** A wireframe glyph per element kind — a sketch, never a real component. */
function Element({ element, accent, type, grow }) {
    const box = { border: '1px solid var(--border-default)', borderRadius: 10, padding: '8px 10px', background: 'var(--bg-primary)', minWidth: 0, flex: grow ? '1 1 120px' : undefined };
    const line = (w, h = 6) => <span style={{ display: 'block', width: w, height: h, borderRadius: 4, background: 'var(--border-default)' }} />;
    const label = <span className="block font-medium truncate mb-1" style={{ fontSize: type.meta, color: 'var(--text-primary)' }} title={element.note || ''}>{element.label}</span>;
    switch (element.kind) {
        case 'stat':
            return <div style={box} data-kind="stat">{label}<span className="block text-lg font-semibold leading-none" style={{ color: accent }}>—</span></div>;
        case 'chart':
            return (
                <div style={box} data-kind="chart">{label}
                    <span className="flex items-end gap-1" style={{ height: 34 }} aria-hidden="true">
                        {[40, 70, 55, 90, 65, 80].map((h, i) => <span key={i} style={{ flex: 1, height: `${h}%`, borderRadius: 3, background: i === 3 ? accent : 'color-mix(in srgb, currentColor 18%, transparent)', color: accent }} />)}
                    </span>
                </div>
            );
        case 'table':
            return <div style={box} data-kind="table">{label}<span className="space-y-1.5 block" aria-hidden="true">{line('100%')}{line('92%')}{line('96%')}</span></div>;
        case 'filters':
            return <div style={box} data-kind="filters">{label}<span className="flex gap-1.5" aria-hidden="true">{[48, 36, 56].map((w, i) => <span key={i} style={{ width: w, height: 14, borderRadius: 999, border: `1px solid ${i === 0 ? accent : 'var(--border-default)'}` }} />)}</span></div>;
        case 'form':
            return <div style={box} data-kind="form">{label}<span className="space-y-1.5 block" aria-hidden="true">{line('100%', 10)}{line('100%', 10)}<span style={{ display: 'block', width: 56, height: 12, borderRadius: 6, background: accent }} /></span></div>;
        case 'detail':
            return <div style={box} data-kind="detail">{label}<span className="space-y-1.5 block" aria-hidden="true">{[['30%', '55%'], ['26%', '40%'], ['34%', '48%']].map(([a, b], i) => <span key={i} className="flex gap-2">{line(a)}{line(b)}</span>)}</span></div>;
        case 'list':
            return <div style={box} data-kind="list">{label}<span className="space-y-1.5 block" aria-hidden="true">{[0, 1, 2].map((i) => <span key={i} className="flex items-center gap-1.5"><span style={{ width: 5, height: 5, borderRadius: 999, background: accent }} />{line('70%')}</span>)}</span></div>;
        case 'button':
            return <div style={{ ...box, borderColor: accent, background: 'color-mix(in srgb, currentColor 10%, transparent)', color: accent }} data-kind="button"><span className="block font-semibold text-center truncate" style={{ fontSize: type.meta }}>{element.label}</span></div>;
        case 'image':
            return <div style={{ ...box, height: 54, background: 'repeating-linear-gradient(135deg, var(--border-default) 0 2px, transparent 2px 8px)' }} data-kind="image">{label}</div>;
        default:
            return <div style={box} data-kind="text">{label}<span className="space-y-1.5 block" aria-hidden="true">{line('100%')}{line('80%')}</span></div>;
    }
}

import { FileText, ListChecks, PenLine, Puzzle, Footprints, MousePointerClick, PanelRight, AppWindow, Clapperboard } from 'lucide-react';
import React from 'react';
import { STEP_TYPES } from '../../../components/onboarding/stepTypes';
import { PRIMARY_ACTION_STYLE } from '../../../components/shared/StudioSectionHeader';

/**
 * Small shared pieces of the redesigned Learning Center — every screen in the
 * handoff draws the same emoji tile, level chip, step-kind icon and button
 * shapes, so they live once here.
 *
 * Buttons: the artboard fills its primary action with ink. That fill was
 * rejected for interactive elements (StudioSectionHeader's docblock), so the
 * primary here wears PRIMARY_ACTION_STYLE — the theme's accent recipe.
 */

/** Lucide glyph per step kind (artboard 1b "Stappen" column). */
export const STEP_KIND_ICON = Object.freeze({
    [STEP_TYPES.SLIDE]: FileText,
    [STEP_TYPES.QUIZ]: ListChecks,
    [STEP_TYPES.EXERCISE]: PenLine,
    [STEP_TYPES.SIM]: Puzzle,
    [STEP_TYPES.TOUR]: Footprints,
    [STEP_TYPES.ACTION]: MousePointerClick,
    [STEP_TYPES.VIDEO]: Clapperboard,
});

export function StepKindIcon({ kind, size = 13, style }) {
    const Icon = STEP_KIND_ICON[kind] || FileText;
    return <Icon style={{ width: size, height: size, flexShrink: 0, ...style }} aria-hidden="true" />;
}

/** The learner-facing name of a step kind. */
export function stepKindLabel(t, kind, count = 1) {
    const one = count === 1;
    switch (kind) {
        case STEP_TYPES.QUIZ: return one ? t('learn.kind.quiz', 'quiz') : t('learn.kind.quiz_plural', 'quizzes');
        case STEP_TYPES.EXERCISE: return one ? t('learn.kind.exercise', 'exercise with AI coach') : t('learn.kind.exercise_plural', 'exercises');
        case STEP_TYPES.SIM: return one ? t('learn.kind.sim', 'simulation') : t('learn.kind.sim_plural', 'simulations');
        case STEP_TYPES.TOUR: return one ? t('learn.kind.tour', 'tour') : t('learn.kind.tour_plural', 'tours');
        case STEP_TYPES.ACTION: return one ? t('learn.kind.action', 'action') : t('learn.kind.action_plural', 'actions');
        case STEP_TYPES.VIDEO: return one ? t('learn.kind.video', 'video') : t('learn.kind.video_plural', 'videos');
        default: return one ? t('learn.kind.slide', 'card') : t('learn.kind.slide_plural', 'cards');
    }
}

/** "4 cards · 4 quizzes · …" as inline icon+count pairs. */
export function StepMixLine({ t, mix, className = '' }) {
    const order = [STEP_TYPES.SLIDE, STEP_TYPES.QUIZ, STEP_TYPES.EXERCISE, STEP_TYPES.SIM, STEP_TYPES.TOUR, STEP_TYPES.ACTION];
    const parts = order.filter((k) => mix?.[k] > 0);
    if (!parts.length) return null;
    return (
        <span className={`inline-flex items-center gap-2 flex-wrap ${className}`.trim()}>
            {parts.map((k) => (
                <span key={k} className="inline-flex items-center gap-[3px] whitespace-nowrap">
                    <StepKindIcon kind={k} size={11} />
                    {mix[k]} {stepKindLabel(t, k, mix[k])}
                </span>
            ))}
        </span>
    );
}

/**
 * The round-3 icon tile: a NEUTRAL square holding a lucide glyph.
 *
 * Deliberately not tinted. The overview shows a column of these, and an
 * accent-tinted tile on every row spends the accent on "this is a course" —
 * something the reader already knows — leaving nothing to say "this is the one
 * you are on". The tint is kept for the 28px header tile, where there is only
 * ever one.
 */
export function IconTile({ icon: Icon, size = 44, locked = false, radius, children }) {
    const glyph = Math.round(size * 0.45);
    return (
        <div
            aria-hidden="true"
            className="grid place-items-center flex-shrink-0"
            style={{
                width: size, height: size,
                borderRadius: radius ?? (size >= 40 ? 10 : 8),
                background: 'var(--bg-secondary)',
                color: locked ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            }}
        >
            {children ?? (Icon && <Icon style={{ width: glyph, height: glyph }} />)}
        </div>
    );
}

/** The emoji tile: accent tint when live, grey + desaturated when locked. */
export function EmojiTile({ icon, size = 40, locked = false, radius, fontSize }) {
    return (
        <div
            aria-hidden="true"
            style={{
                width: size, height: size, flexShrink: 0,
                borderRadius: radius ?? (size >= 48 ? 12 : size >= 36 ? 10 : 8),
                display: 'grid', placeItems: 'center', lineHeight: 1,
                fontSize: fontSize ?? Math.round(size / 2),
                background: locked ? 'var(--bg-tertiary)' : 'color-mix(in srgb, var(--accent-primary) 18%, transparent)',
                filter: locked ? 'grayscale(1)' : undefined,
                opacity: locked ? 0.7 : 1,
            }}
        >
            {icon}
        </div>
    );
}

/** BEGINNER / INTERMEDIATE / ADVANCED — 10px uppercase hairline chip. */
export function LevelChip({ t, level }) {
    if (!level) return null;
    return (
        <span
            className="inline-flex items-center whitespace-nowrap flex-shrink-0 uppercase"
            style={{
                padding: '1px 6px', borderRadius: 999, border: '1px solid var(--border-default)',
                fontSize: 10, fontWeight: 600, letterSpacing: '.04em', color: 'var(--text-secondary)',
            }}
        >
            {t(`learn.level.${level}`, level)}
        </span>
    );
}

/** A badge name with its emoji; greyed until earned. */
export function BadgeMark({ badge, earned, t, className = '' }) {
    if (!badge) return null;
    return (
        <span
            className={`inline-flex items-center gap-1 whitespace-nowrap min-w-0 ${className}`.trim()}
            style={earned ? undefined : { filter: 'grayscale(1)', opacity: 0.6 }}
        >
            <span aria-hidden="true">{badge.icon}</span>
            <span className="truncate">{t(badge.titleKey, badge.titleFallback)}</span>
        </span>
    );
}

/** "in window" / "beside the app" — the Plays chip (artboard 1b). */
export function PlaysChip({ t, plays }) {
    const docked = plays === 'docked';
    const Icon = docked ? PanelRight : AppWindow;
    return (
        <span
            className="inline-flex items-center gap-1 whitespace-nowrap"
            style={docked
                ? { padding: '1px 7px', borderRadius: 999, background: 'color-mix(in srgb, var(--accent-primary) 16%, transparent)', color: 'var(--accent-primary)', fontSize: 11, fontWeight: 600 }
                : { padding: '1px 7px', borderRadius: 999, border: '1px solid var(--border-default)', color: 'var(--text-secondary)', fontSize: 11 }}
        >
            <Icon style={{ width: 11, height: 11 }} aria-hidden="true" />
            {docked ? t('learn.plays.docked', 'beside the app') : t('learn.plays.modal', 'in window')}
        </span>
    );
}

const BTN_BASE = 'inline-flex items-center justify-center gap-1.5 whitespace-nowrap flex-shrink-0 rounded-[10px] transition disabled:opacity-40 disabled:cursor-not-allowed';

/** The 32px filled primary button (accent recipe, never ink). */
export function PrimaryButton({ children, className = '', small = false, style, ...rest }) {
    return (
        <button
            type="button"
            className={`${BTN_BASE} font-semibold ${small ? 'h-[26px] px-2.5 text-[12px] rounded-lg' : 'h-8 px-3 text-[12px]'} ${className}`.trim()}
            style={{ ...PRIMARY_ACTION_STYLE, ...style }}
            {...rest}
        >
            {children}
        </button>
    );
}

/** The 32px outlined secondary button. */
export function SecondaryButton({ children, className = '', small = false, style, ...rest }) {
    return (
        <button
            type="button"
            className={`${BTN_BASE} font-medium hover:bg-[var(--bg-tertiary)] ${small ? 'h-[26px] px-2.5 text-[12px] rounded-lg' : 'h-8 px-3 text-[12px]'} ${className}`.trim()}
            style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-primary)', ...style }}
            {...rest}
        >
            {children}
        </button>
    );
}

/** 32×32 icon-only outlined button. */
export function IconSquareButton({ children, className = '', ...rest }) {
    return (
        <button
            type="button"
            className={`grid place-items-center w-8 h-8 rounded-[10px] flex-shrink-0 transition hover:bg-[var(--bg-tertiary)] ${className}`.trim()}
            style={{ border: '1px solid var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-secondary)' }}
            {...rest}
        >
            {children}
        </button>
    );
}

/** The 12px card the artboards build everything from. */
export function Card({ children, className = '', style, ...rest }) {
    return (
        <div
            className={`rounded-xl ${className}`.trim()}
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border-default)', boxShadow: 'var(--shadow-sm)', ...style }}
            {...rest}
        >
            {children}
        </div>
    );
}

/** 10px uppercase eyebrow label. */
export function Eyebrow({ children, accent = false, className = '' }) {
    return (
        <div
            className={`uppercase font-semibold ${className}`.trim()}
            style={{ fontSize: 10, letterSpacing: '.08em', color: accent ? 'var(--accent-primary)' : 'var(--text-tertiary)' }}
        >
            {children}
        </div>
    );
}

/** t() for copy that may be absent: no key and no fallback → ''. */
export function tOpt(t, key, fallback) {
    if (fallback) return t(key, fallback);
    return key ? t(key) : '';
}

/** "12 sep" — a short date for earned/mastered stamps. */
export function shortDate(iso, locale) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString(locale || undefined, { day: 'numeric', month: 'short' }); }
    catch (_) { return ''; }
}

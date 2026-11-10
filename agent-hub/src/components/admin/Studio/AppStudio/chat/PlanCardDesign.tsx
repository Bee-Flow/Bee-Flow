import { Palette } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { APP_DESIGN_PRESETS } from '../runtime/appDesignPresets';

/**
 * The LOOK of a build plan (the plan's `design`, app_propose_plan): the direction sentence the
 * builder wrote, the preset it starts from, colour, typeface, navigation, surface and its
 * signature moves. Shown in the plan card so the user approves the look with the tables and
 * screens. The direction is editable (it is what the builder is held to); the rest is read as
 * the builder proposed it. A plan without a design shows nothing.
 *
 * The plan is authored by a model, so every value is read defensively: a key of the wrong type
 * is skipped, never rendered.
 */

interface PlanDesignView {
    direction?: string;
    preset?: string;
    primary?: string;
    font?: string;
    navStyle?: string;
    surface?: string;
    signatureMoves?: string[];
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** "#rrggbb" or ''. Checked by hand: the value goes into an SVG attribute. */
function hexColour(v: unknown): string {
    const s = text(v);
    if (s.length !== 7 || s[0] !== '#') return '';
    for (const ch of s.slice(1)) if (!'0123456789abcdefABCDEF'.includes(ch)) return '';
    return s;
}

/** The design as the card shows it, or null when the plan has none. */
function readPlanDesign(raw: unknown): PlanDesignView | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const view: PlanDesignView = {};
    // The direction is edited in place, so an emptied one stays (as '') while the user types.
    if (typeof r.direction === 'string') view.direction = r.direction;
    for (const key of ['preset', 'font', 'navStyle', 'surface'] as const) {
        const value = text(r[key]);
        if (value) view[key] = value;
    }
    const primary = hexColour(r.primary);
    if (primary) view.primary = primary;
    const moves = Array.isArray(r.signatureMoves) ? r.signatureMoves.map(text).filter(Boolean).slice(0, 3) : [];
    if (moves.length) view.signatureMoves = moves;
    return Object.keys(view).length ? view : null;
}

function Chip({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
    return (
        <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 border-[var(--border-default)] text-[var(--text-secondary)]">
            {swatch ? (
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill={swatch} /></svg>
            ) : null}
            <span className="text-[var(--text-tertiary)]">{label}</span>
            <span className="font-medium text-[var(--text-primary)]">{value}</span>
        </span>
    );
}

interface PlanCardDesignProps {
    design: unknown;
    disabled?: boolean;
    onDirectionChange?: (direction: string) => void;
}

export default function PlanCardDesign({ design, disabled = false, onDirectionChange }: PlanCardDesignProps) {
    const { t } = useTranslation();
    const view = readPlanDesign(design);
    if (!view) return null;
    const presetName = view.preset === 'custom'
        ? t('studio_apps_plan_design.custom', 'Custom')
        : (APP_DESIGN_PRESETS.find((p) => p.id === view.preset)?.name || view.preset || '');
    return (
        <div className="flex flex-col gap-1.5" data-plan-design="">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--text-secondary)]">
                <Palette className="h-3.5 w-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
                {t('studio_apps_plan_design.title', 'Look')}
            </div>
            {view.direction !== undefined ? (
                <input
                    type="text"
                    value={view.direction}
                    disabled={disabled}
                    maxLength={200}
                    onChange={(e) => onDirectionChange?.(e.target.value)}
                    aria-label={t('studio_apps_plan_design.direction', 'Design direction')}
                    className="w-full rounded border bg-transparent px-1.5 py-1 outline-none disabled:opacity-60 border-[var(--border-default)] text-[var(--text-primary)]"
                />
            ) : null}
            <div className="flex flex-wrap gap-1">
                {presetName ? <Chip label={t('studio_apps_plan_design.preset', 'Preset')} value={presetName} /> : null}
                {view.primary ? <Chip label={t('studio_apps_plan_design.colour', 'Colour')} value={view.primary} swatch={view.primary} /> : null}
                {view.font ? <Chip label={t('studio_apps_plan_design.font', 'Typeface')} value={view.font} /> : null}
                {view.navStyle ? <Chip label={t('studio_apps_plan_design.navigation', 'Navigation')} value={view.navStyle} /> : null}
                {view.surface ? <Chip label={t('studio_apps_plan_design.surface', 'Surfaces')} value={view.surface} /> : null}
            </div>
            {view.signatureMoves ? (
                <ul className="flex list-disc flex-col gap-0.5 pl-4 text-[var(--text-secondary)]" aria-label={t('studio_apps_plan_design.moves', 'What makes it its own')}>
                    {view.signatureMoves.map((move, i) => <li key={i}>{move}</li>)}
                </ul>
            ) : null}
        </div>
    );
}

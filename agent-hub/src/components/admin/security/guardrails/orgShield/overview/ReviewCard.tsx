import {
    ArrowRight, ArrowUpRight, Ban, CircleX, Eye, EyeOff, Globe, ScanSearch, TriangleAlert, UserCheck, Wrench,
    type LucideIcon,
} from 'lucide-react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { reviewCopy, reviewHeading, settingName } from './overviewCopy';
import type { GoTo, PostureRow, Tone } from './types';

/**
 * "3 things to review": the posture rows worth a second look, most urgent
 * first (see reviewItems in orgShieldPosture.js). The card is the Overview's
 * to-do list; the step cards below it are the full read-out.
 */

const ICONS: Record<string, LucideIcon> = {
    guard: CircleX,
    categories: ScanSearch,
    action: Ban,
    toolcalls: Wrench,
    eu: Globe,
    transparency: Eye,
    allowlist: EyeOff,
    dlp: UserCheck,
};

// Written out per tone: Tailwind only generates classes it can see.
const TILE: Record<Tone, string> = {
    error: 'bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-[var(--warning-ink)]',
    warn: 'bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-[var(--warning-ink)]',
    note: 'bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-[var(--warning-ink)]',
    suggest: 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]',
    ok: 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]',
};

const LINK = 'text-xs font-semibold text-[var(--info-ink)] inline-flex items-center gap-1 hover:underline whitespace-nowrap';
const DARK_BUTTON = 'inline-flex items-center gap-[5px] px-[11px] py-1.5 rounded-lg bg-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)] text-xs font-semibold whitespace-nowrap hover:opacity-90';

interface ActionProps {
    row: PostureRow;
    t: TranslateFn;
    onGoTo: GoTo;
    showActivity: boolean;
    onDiagnoseGuard?: () => void;
}

/** What the admin can do about one item: a jump to the setting, or for the scanner, a diagnosis. */
function ItemActions({ row, t, onGoTo, showActivity, onDiagnoseGuard }: ActionProps) {
    if (row.id === 'guard') {
        // Nothing on this screen fixes an absent scanner, so no "Change →".
        return onDiagnoseGuard ? (
            <button type="button" onClick={onDiagnoseGuard} className={DARK_BUTTON}>
                {t('admin.shield_posture_diagnose', 'Diagnose')}
                <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
            </button>
        ) : null;
    }
    if (row.id === 'toolcalls') {
        return (
            <div className="flex gap-3 items-center flex-wrap justify-start @min-[560px]/pane:justify-end">
                {showActivity && (
                    <button type="button" onClick={() => onGoTo('activity')} className={LINK}>
                        {t('shield_overview.see_calls', 'See calls')}
                    </button>
                )}
                <button type="button" onClick={() => onGoTo('detection')} className={DARK_BUTTON}>
                    {t('shield_overview.hold_back', 'Hold kinds back')}
                    <ArrowRight className="w-3 h-3" aria-hidden="true" />
                </button>
            </div>
        );
    }
    if (!row.tab) return null;
    const tab = row.tab;
    return (
        <button
            type="button"
            onClick={() => onGoTo(tab)}
            aria-label={t('shield_overview.change_setting', 'Change {setting}', { setting: settingName(row.id, t) })}
            className={`${LINK} @min-[560px]/pane:pt-1.5`}
        >
            {t('admin.shield_posture_change', 'Change')}
            <ArrowRight className="w-3 h-3" aria-hidden="true" />
        </button>
    );
}

function ReviewItem(props: ActionProps) {
    const { row, t } = props;
    const copy = reviewCopy(row, t);
    if (!copy) return null;
    const Icon = ICONS[row.id] || TriangleAlert;
    return (
        <li className="grid grid-cols-[28px_minmax(0,1fr)] @min-[560px]/pane:grid-cols-[28px_minmax(0,1fr)_auto] gap-x-3 gap-y-2 items-start px-[18px] py-3.5 border-t border-[var(--border-subtle)]">
            <span aria-hidden="true" className={`w-6 h-6 rounded-[7px] grid place-items-center ${TILE[row.tone]}`}>
                <Icon className="w-[13px] h-[13px]" aria-hidden="true" />
            </span>
            <div className="min-w-0">
                <p className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{copy.title}</p>
                <p className="m-0 text-xs leading-[18px] text-[var(--text-secondary)] text-pretty">{copy.body}</p>
            </div>
            {/* On a narrow pane the actions go under the text, so the finding keeps its width. */}
            <div className="col-start-2 @min-[560px]/pane:col-start-auto flex justify-start @min-[560px]/pane:justify-end empty:hidden">
                <ItemActions {...props} />
            </div>
        </li>
    );
}

interface Props {
    items: PostureRow[];
    hasEvidence: boolean;
    showActivity: boolean;
    t: TranslateFn;
    onGoTo: GoTo;
    onDiagnoseGuard?: () => void;
}

export default function ReviewCard({ items, hasEvidence, showActivity, t, onGoTo, onDiagnoseGuard }: Props) {
    if (items.length === 0) return null;
    const heading = reviewHeading(items.length, hasEvidence, t);
    return (
        <section
            aria-labelledby="org-shield-review-title"
            className="rounded-xl bg-[var(--bg-card)] border border-[color-mix(in_srgb,var(--warning)_45%,transparent)] shadow-[var(--shadow-sm)] overflow-hidden"
        >
            <div className="flex items-center gap-2 flex-wrap px-[18px] py-3 bg-[color-mix(in_srgb,var(--warning)_8%,transparent)]">
                <TriangleAlert className="w-[15px] h-[15px] text-[var(--warning-ink)]" aria-hidden="true" />
                <h3 id="org-shield-review-title" className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    {heading.title}
                </h3>
                <span className="text-xs text-[var(--text-secondary)]">{heading.basis}</span>
            </div>
            <ul className="m-0 p-0 list-none">
                {items.map(row => (
                    <ReviewItem
                        key={row.id}
                        row={row}
                        t={t}
                        onGoTo={onGoTo}
                        showActivity={showActivity}
                        onDiagnoseGuard={onDiagnoseGuard}
                    />
                ))}
            </ul>
        </section>
    );
}

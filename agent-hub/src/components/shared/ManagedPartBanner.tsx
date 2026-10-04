import { Lock } from 'lucide-react';
import type { MouseEvent } from 'react';
import useTranslation, { type TranslateFn, type TranslateParams } from '../../hooks/useTranslation';
import { devTarget, hrefOf, stageSettingsTarget, type ManagedPart } from './managedPart';

/**
 * "Managed by <Solution> · Production · Release 7. Read-only so it stays
 * exactly what UAT tested. Change it in Dev and deploy." with the two ways out:
 * Open in Dev and Stage settings (design 9).
 *
 * One banner for every builder a stage part opens in (automation, app, page,
 * agent, skill, document, table). It knows nothing about any of them: the
 * caller hands it what the server said (`managedOf(partPayload)`, or the
 * `managed` of a refused write, `fromError(body)`), and it says it.
 *
 * `notDeployed` is the other refusal: a stage part no release has reached yet
 * cannot be run or published, and the sentence says so instead of "read-only".
 *
 * `onNavigate` takes the in-app route (`studio/solutions/<id>?stage=prd`); a
 * host without one still gets real links.
 */

export interface ManagedPartBannerProps {
    managed: ManagedPart | null;
    notDeployed?: boolean;
    onNavigate?: ((target: string) => void) | null;
    className?: string;
}

const ACCENT = {
    uat: 'border-l-[color:var(--stage-uat,var(--accent-primary))]',
    prd: 'border-l-[color:var(--stage-prd,var(--accent-primary))]',
} as const;

/**
 * t() with the placeholders ALWAYS filled in. The real translator interpolates
 * `{solution}` itself, but a `t` handed in by a test or an embed does not, and
 * a banner that reads "Managed by {solution}" is worse than none (the same
 * reason AgentEditorHeader and VisibilityCapsule carry a `tx`).
 */
function fill(t: TranslateFn, key: string, fallback: string, params: TranslateParams): string {
    let value = t(key, fallback, params);
    if (typeof value !== 'string') value = fallback;
    for (const [name, v] of Object.entries(params)) value = value.split(`{${name}}`).join(String(v));
    return value;
}

const LINK = 'inline-flex items-center min-h-[32px] rounded font-medium text-[var(--accent-primary)] hover:underline whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]';

/** "Managed by Intake · Production · Release 7": what the server could say, in that order. */
function headingOf(t: TranslateFn, managed: ManagedPart | null): string {
    if (!managed) return '';
    const stage = managed.stage === 'prd' ? t('managed_part.stage_prd', 'Production') : t('managed_part.stage_uat', 'UAT');
    const stageLine = managed.releaseSeq == null
        ? stage
        : fill(t, 'managed_part.banner_stage', '{stage} · Release {seq}', { stage, seq: managed.releaseSeq });
    const title = managed.solutionName
        ? fill(t, 'managed_part.banner_title', 'Managed by {solution}', { solution: managed.solutionName })
        : null;
    return [title, stageLine].filter(Boolean).join(' · ');
}

interface LinksProps {
    managed: ManagedPart;
    onNavigate: ((target: string) => void) | null;
}

/** Open in Dev and Stage settings: real links, handed to `onNavigate` when the host has one. */
function Links({ managed, onNavigate }: LinksProps) {
    const { t } = useTranslation();
    const go = (target: string) => (e: MouseEvent<HTMLAnchorElement>) => {
        if (!onNavigate || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onNavigate(target);
    };
    const devPath = devTarget(managed);
    const settingsPath = stageSettingsTarget(managed);
    return (
        <span className="flex flex-wrap items-center gap-x-4 flex-shrink-0">
            <a href={hrefOf(devPath)} onClick={go(devPath)} className={LINK} data-testid="managed-open-dev">
                {t('managed_part.open_in_dev', 'Open in Dev')}
            </a>
            <a href={hrefOf(settingsPath)} onClick={go(settingsPath)} className={LINK} data-testid="managed-stage-settings">
                {t('managed_part.stage_settings', 'Stage settings')}
            </a>
        </span>
    );
}

export default function ManagedPartBanner({ managed, notDeployed = false, onNavigate = null, className = '' }: ManagedPartBannerProps) {
    const { t } = useTranslation();
    if (!managed && !notDeployed) return null;
    const heading = headingOf(t, managed);
    const body = notDeployed
        ? t('managed_part.not_deployed', 'This part has not been deployed yet.')
        : t('managed_part.banner_body', 'Read-only so it stays exactly what UAT tested. Change it in Dev and deploy.');
    const accent = ACCENT[managed?.stage ?? 'prd'];

    return (
        <div
            role="note"
            data-testid="managed-part-banner"
            data-stage={managed?.stage ?? ''}
            className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-3.5 py-2 text-[13px] text-[var(--text-secondary)] bg-[var(--bg-secondary)] border-b border-[var(--border-default)] border-l-[3px] ${accent} ${className}`}
        >
            <Lock size={13} aria-hidden="true" className="flex-shrink-0 text-[var(--text-tertiary)]" />
            <p className="m-0 min-w-0 flex-1 basis-[18rem]">
                {heading && <strong className="font-semibold text-[var(--text-primary)]">{heading}. </strong>}
                {body}
            </p>
            {managed && <Links managed={managed} onNavigate={onNavigate} />}
        </div>
    );
}

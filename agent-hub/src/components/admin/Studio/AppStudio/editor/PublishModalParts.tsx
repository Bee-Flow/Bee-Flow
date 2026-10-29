import { CheckCircle2, ExternalLink, LayoutGrid, Loader2, Stethoscope } from 'lucide-react';
import type { TranslateFn, TranslateParams } from '@/hooks/useTranslation';
import type { DryRunIssue } from './dryRunIssues';
import type { Findings, IssueTarget } from './PublishModal.types';
import { GROUPS } from './publishAccessSummary';
import { audienceLabel } from './PublishModal.helpers';
import { BlockerList } from './BlockerList';

// The pieces of the Publish modal: its footer, the pre-flight check, the current status and the Nextcloud menu option.

/** Cancel and Apply (spinning while the publish is in flight). */
export function PublishFooter({ t, busy, canApply, onCancel, onApply }: { t: TranslateFn; busy: boolean; canApply: boolean; onCancel: () => void; onApply: () => void }) {
    return (
        <>
            <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="rounded-lg bg-white/5 px-4 py-2 text-sm hover:bg-[var(--bg-card-hover)] disabled:opacity-50 text-[var(--text-primary)]"
            >
                {t('app_studio.publish.cancel', 'Cancel')}
            </button>
            <button
                type="button"
                onClick={onApply}
                disabled={!canApply}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50 bg-[var(--accent-primary)]"
            >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
                {t('app_studio.publish.apply', 'Apply')}
            </button>
        </>
    );
}

interface CheckPanelProps {
    t: TranslateFn;
    checking: boolean;
    canCheck: boolean;
    onCheck: () => void;
    checkResult: Findings | null;
    revealTarget: (issue: DryRunIssue) => IssueTarget | null;
    onReveal: (target: IssueTarget) => void;
}

/**
 * Try it before anyone else has to. The publish gate only refuses what it can
 * prove statically; this actually runs the app's data reads, so an empty list,
 * a screen that is blank for everyone but the owner, or a save step writing a
 * column that was renamed all surface here rather than in front of a colleague.
 */
export function CheckPanel({ t, checking, canCheck, onCheck, checkResult, revealTarget, onReveal }: CheckPanelProps) {
    return (
    <div
        className="rounded-lg border px-3 py-2.5 border-[var(--border-subtle)] bg-[var(--bg-primary)]"
    >
        <div className="flex items-center gap-2">
            <button
                type="button"
                onClick={onCheck}
                disabled={checking || !canCheck}
                className="inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2.5 py-1.5 text-xs font-medium hover:bg-[var(--bg-card-hover)] disabled:opacity-50 text-[var(--text-primary)]"
            >
                {checking
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    : <Stethoscope className="h-3.5 w-3.5" aria-hidden="true" />}
                {checking
                    ? t('app_studio.publish.checking', 'Checking…')
                    : t('app_studio.publish.check', 'Check this app')}
            </button>
            <span className="text-xs text-[var(--text-tertiary)]">
                {t('app_studio.publish.check_hint', 'Tries the app’s screens and logic without changing anything.')}
            </span>
        </div>

        {checkResult && !checking ? (
            checkResult.errors.length === 0 && checkResult.warnings.length === 0 ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {t('app_studio.publish.check_all_good', 'Everything loaded and every step checks out.')}
                </p>
            ) : (
                <div className="mt-2.5">
                    <BlockerList
                        errors={checkResult.errors}
                        warnings={checkResult.warnings}
                        revealTarget={revealTarget}
                        onReveal={onReveal}
                        context="check"
                    />
                </div>
            )
        ) : null}
    </div>
    );
}

/** Show the app in the connected Nextcloud's app menu (the icon is instance-wide; the audience still decides who can use it). */
export function NcMenuOption({ t, checked, onChange }: { t: TranslateFn; checked: boolean; onChange: (on: boolean) => void }) {
    return (
        <label
            className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 border-[var(--border-subtle)] bg-[var(--bg-primary)]"
        >
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent-primary)]"
            />
            <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium text-[var(--text-primary)]">
                    <LayoutGrid className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {t('app_studio.publish.nc_menu', 'Show in the Nextcloud app menu')}
                </span>
                <span className="mt-0.5 block text-xs text-[var(--text-tertiary)]">
                    {t('app_studio.publish.nc_menu_desc', 'Adds this app to the top bar of your organization’s connected Nextcloud, opening on its own page. The icon shows up after you reload Nextcloud. Everyone on that Nextcloud sees the icon; only the audience you chose above can use the app — others see a notice that it is shared with specific groups.')}
                </span>
            </span>
        </label>
    );
}

export function PublishModalSection({ t, currentAudience, currentGroups, isPublished, publishedAt, liveHref }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; currentAudience: string; currentGroups: string[]; isPublished: boolean; publishedAt: string | null; liveHref: string | null; }) {
    return <div
        className="rounded-lg border px-3 py-2.5 text-xs border-[var(--border-subtle)] bg-[var(--bg-primary)]"
    >
        <div className="flex items-center gap-2 text-[var(--text-secondary)]">
            <span>{t('app_studio.publish.currently', 'Currently:')}</span>
            <strong className="text-[var(--text-primary)]">{audienceLabel(t, currentAudience)}</strong>
            {currentAudience === GROUPS ? (
                <span className="text-[var(--text-tertiary)]">({currentGroups.length})</span>
            ) : null}
        </div>
        {isPublished && publishedAt ? (
            <div className="mt-1 text-[var(--text-tertiary)]">
                {t('app_studio.publish.last_published', 'Last published {when}', { when: publishedAt })}
            </div>
        ) : null}
        {isPublished && liveHref ? (
            <a
                href={liveHref}
                className="mt-1.5 inline-flex items-center gap-1 font-medium hover:underline text-[var(--accent-primary)]"
            >
                {t('app_studio.publish.view_live', 'View live')} <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
        ) : null}
    </div>;
}

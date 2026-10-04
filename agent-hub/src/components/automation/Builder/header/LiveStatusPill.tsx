import useTranslation from '../../../../hooks/useTranslation';
import type { LiveState } from './liveState';

/**
 * The automation's status in plain language (artboard 5a/5d):
 *   "Draft · never live"  open circle, neutral outline
 *   "Live · v3"           success tint, filled dot
 *   "Paused"              neutral outline, filled dot
 * plus, when the working copy is ahead of the live version, a quiet
 * "editing v5 · 2 changes not live yet". That line only shows on a bar of
 * 1700px or more, where the name keeps room beside it; it never truncates
 * into "editing v5 · …". Below that it is the pill's tooltip, and "Make vN
 * live" says the rest.
 */
export default function LiveStatusPill({ live }: { live: LiveState }) {
    const { t } = useTranslation();
    let label: string;
    if (live.kind === 'never') label = t('automations.header.status_never_live', 'Draft · never live');
    else if (live.kind === 'live') {
        label = live.liveVersion != null
            ? t('automations.header.status_live_version', 'Live · v{version}', { version: live.liveVersion })
            : t('automations.header.status_live', 'Live');
    } else label = t('automations.header.status_paused', 'Paused');

    const tone = live.kind === 'live'
        ? 'bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)] font-semibold'
        : 'border border-[var(--border-default)] text-[var(--text-secondary)]';
    const dot = live.kind === 'never'
        ? 'border-[1.5px] border-[var(--text-tertiary)]'
        : (live.kind === 'live' ? 'bg-[var(--success)]' : 'bg-[var(--text-tertiary)]');

    const pending = live.kind !== 'never' && live.pendingChanges > 0;
    const pendingText = !pending ? undefined : (live.pendingChanges === 1
        ? t('automations.header.editing_pending_one', 'editing v{version} · 1 change not live yet', { version: live.workingVersion ?? '' })
        : t('automations.header.editing_pending_other', 'editing v{version} · {n} changes not live yet', { version: live.workingVersion ?? '', n: live.pendingChanges }));
    return (
        <>
            <span
                data-testid="live-status"
                data-kind={live.kind}
                title={pendingText}
                className={`inline-flex items-center gap-[5px] px-2 py-0.5 rounded-full text-[12px] whitespace-nowrap flex-shrink-0 ${tone}`}
            >
                <span aria-hidden="true" className={`w-[7px] h-[7px] rounded-full box-border ${dot}`} />
                {label}
            </span>
            {pending && (
                <span
                    data-testid="live-pending"
                    className="hidden @min-[1700px]/bar:inline text-[12px] text-[var(--text-tertiary)] whitespace-nowrap flex-shrink-0"
                >
                    {pendingText}
                </span>
            )}
        </>
    );
}

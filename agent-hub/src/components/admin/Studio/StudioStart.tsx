import { Lock } from 'lucide-react';
import AttentionList from './attention/AttentionList';
import StudioMap from './map/StudioMap';
import RecentWorkList from './recent/RecentWorkList';
import { groupStudioApps, studioLockHint } from './studioGates';
import { STUDIO_SECTIONS } from './studioSections';
import StudioHomeHeader from './StudioHomeHeader';
import { studioGateContext, studioNavSections, studioSectionLabel, type StudioLabelled } from './studioNav';
import { useStudioCounts } from '../../../hooks/useStudioCounts';
import { useTranslation } from '../../../hooks/useTranslation';
import { useRuntimeStudioApps } from '../../../moduleRuntime/registry';
import { useEntitlements } from '../../licensing/EntitlementsContext';
import { useLicenseContext } from '../../licensing/LicenseContext';
import { kindColorVar } from '../../shared/kindColors';

/**
 * Studio's front door — what `/app/studio` opens with no segment (Track H1).
 *
 * Deliberately small. Before H1 the bare path resolved to the Agents section;
 * now it resolves to `start`, and a section id the shell cannot render is a
 * blank white pane, so this screen exists to be the thing that renders. It
 * shows the sections the rail shows, from the same registry through the same
 * gate resolution (studioNav.js), and opens them.
 *
 * What it deliberately does NOT do: POLL for counts. The rail already polls
 * GET /api/studio/counts every 30s; a second poller on the same screen would
 * double that request for every open tab to say the same number twice. A
 * section row here says what it IS, and the number lives one glance to the
 * left.
 *
 * TWO pieces need that body — the map (map/StudioMap.jsx), because a building
 * block with no number next to it is a legend rather than an inventory, and
 * the header (StudioHomeHeader.jsx) for the makers figure — so this screen
 * reads it ONCE, here, and hands it to both. Both can read it themselves when
 * they are mounted alone; letting them do it here would mean two requests per
 * open, and worse, two readings of one answer that can disagree — a makers
 * figure out of a body the map at the same moment calls unreadable.
 *
 * Artboard 1b's richer Studio Home landed ON TOP of that floor in Track H3,
 * in four pieces that each keep their own rule and are each readable on their
 * own: the header (StudioHomeHeader.jsx — the makers figure, the "New" split
 * menu, and "describe what you want", which Track H4 turned from a placeholder
 * into the real building-block picker), "vraagt aandacht" (attention/),
 * "laatst bewerkt" (recent/) and the map (map/).
 *
 * That picker is the header's, not this screen's: it is the header that owns
 * both entrances to it (the card itself and the "New" menu's AI row), so there
 * is ONE panel here and one place its state lives. This screen only hands the
 * header the same gated `sections` it hands everything else — a kind this
 * reader may not make must stay a signpost in the picker too.
 */
interface StudioStartProps {
    user?: { id?: string; organization?: { id: string; name: string }; permissions?: string[] } | null;
    onNavigate?: ((target: string) => void) | null;
    hasPermission?: (permission: string) => boolean;
}

export default function StudioStart({ user, onNavigate, hasPermission = () => true }: StudioStartProps) {
    const { t, locale } = useTranslation();
    const { hasFeature: hasLicenseFeature } = useLicenseContext();
    const {
        can, lockReason, loading: entitlementsLoading, error: entitlementsError,
    } = useEntitlements();
    const runtimeStudioApps = useRuntimeStudioApps();
    // One read for this entire screen, without a timer. `failed` travels along: a failed
    // read is something other than a read that is still running, and without a poller
    // the first will never come back.
    const { counts, makers, failed: countsFailed } = useStudioCounts({ poll: false });

    const ctx = studioGateContext({
        user, hasLicenseFeature, hasPermission, can, lockReason,
        entitlementsLoading, entitlementsError,
    });
    const sections = studioNavSections([...STUDIO_SECTIONS, ...runtimeStudioApps], ctx);
    const groups = groupStudioApps(sections);

    // Runtime modules carry a locale-aware label() fn; built-ins an i18n key. Both
    // answers are in studioNav.js, so a section here cannot be named differently from
    // how it is on the rail or in “Last edited”.
    const labelOf = (app: StudioLabelled | null) => studioSectionLabel(app, t, locale);
    const descOf = (app: { descKey?: string; descFallback?: string }) => (app.descKey ? t(app.descKey, app.descFallback) : null);

    return (
        <div className="h-full overflow-y-auto custom-scrollbar" data-testid="studio-start">
            <div className="max-w-4xl mx-auto px-6 py-8">
                {/* Who builds here, what you can create new, and “describe what you want” — the
                    latter a real panel since H4, which the header carries itself
                    (studioAi/DescribeItPanel). The same gated `sections` as the rest of
                    this screen go along, so the panel offers no kind that is locked
                    below. The makers number is counted on the server — see
                    StudioHomeHeader.jsx. */}
                <StudioHomeHeader user={user} sections={sections} onNavigate={onNavigate} makers={makers} />

                {/* What is asking for a person, above what there is to open.
                    Its own component because it is the one thing on this screen
                    that goes to the network, and because the rule it keeps —
                    "found nothing" is not "could not look" — is worth reading
                    on its own (attention/attentionChecks.js). */}
                <AttentionList user={user} hasFeature={hasLicenseFeature} onNavigate={onNavigate} />

                {/* Afterwards, where you left off. The same sections, the same gates: a list
                    that this person may not see is not requested, and a list that fails
                    says so (recent/). */}
                {/* `gatesResolved`: while the entitlements are loading or have fallen over,
                    resolveStudioNav OMITS the gated sections entirely — then “nothing
                    edited yet” is a reassurance about seven lists that were never
                    requested. Unknown narrows. */}
                <RecentWorkList
                    sections={sections}
                    onNavigate={onNavigate}
                    gatesResolved={!entitlementsLoading && !entitlementsError}
                />

                {groups.map(({ category, apps }) => (
                    <section key={category.id} className="mt-8">
                        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                            {t(category.labelKey, category.labelFallback)}
                        </h2>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            {apps.map((app) => {
                                const locked = !!app.locked;
                                const hint = locked ? studioLockHint(app.locked, t) : null;
                                const Icon = app.Icon;
                                const color = app.kind ? kindColorVar(app.kind) : 'var(--text-secondary)';
                                return (
                                    <button
                                        key={app.id}
                                        type="button"
                                        // A locked section stays a signpost, never a door — the
                                        // same contract the rail's rows keep. aria-disabled
                                        // rather than `disabled` so the hint is still reachable
                                        // from the keyboard and the tooltip still shows.
                                        onClick={locked ? () => {} : () => onNavigate?.(`studio/${app.urlSegment}`)}
                                        aria-disabled={locked ? 'true' : undefined}
                                        title={hint || undefined}
                                        data-testid={`studio-start-${app.id}`}
                                        data-locked={locked ? 'true' : undefined}
                                        className={`flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3 text-left transition-colors ${locked ? 'opacity-60 cursor-not-allowed' : 'hover:border-[var(--border-default)]'}`}
                                    >
                                        {Icon && <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color }} strokeWidth={1.75} />}
                                        <span className="flex-1 min-w-0">
                                            <span className="block text-[13px] font-medium text-[var(--text-primary)]">{labelOf(app)}</span>
                                            {descOf(app) && (
                                                <span className="line-clamp-2 text-[11.5px] leading-snug mt-0.5 text-[var(--text-tertiary)]">
                                                    {descOf(app)}
                                                </span>
                                            )}
                                            {locked && hint && (
                                                <span className="block text-[11.5px] leading-snug mt-0.5 text-[var(--text-tertiary)]" data-testid={`studio-start-${app.id}-lock-hint`}>
                                                    {hint}
                                                </span>
                                            )}
                                        </span>
                                        {locked && <Lock className="w-3.5 h-3.5 flex-shrink-0 mt-1 text-[var(--text-tertiary)]" strokeWidth={1.75} aria-hidden="true" />}
                                    </button>
                                );
                            })}
                        </div>
                    </section>
                ))}

                {/* At the bottom, because it is the answer to a second question: not “where am I
                    going” but “how do these things fit together”. Deliberately a
                    hand-drawn legend and not a live org-wide graph — the reason is in
                    map/studioMap.js and stays. */}
                <StudioMap counts={counts} countsFailed={countsFailed} />
            </div>
        </div>
    );
}

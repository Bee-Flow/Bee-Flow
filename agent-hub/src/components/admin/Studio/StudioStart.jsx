import { Lock } from 'lucide-react';
import React from 'react';
import AttentionList from './attention/AttentionList';
import StudioMap from './map/StudioMap';
import RecentWorkList from './recent/RecentWorkList';
import { groupStudioApps, STUDIO_APPS, studioLockHint } from './studioApps';
import StudioHomeHeader from './StudioHomeHeader';
import { studioGateContext, studioNavSections, studioSectionLabel } from './studioNav';
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
export default function StudioStart({ user, onNavigate, hasPermission = () => true }) {
    const { t, locale } = useTranslation();
    const { hasFeature: hasLicenseFeature } = useLicenseContext();
    const {
        can, lockReason, loading: entitlementsLoading, error: entitlementsError,
    } = useEntitlements();
    const runtimeStudioApps = useRuntimeStudioApps();
    // Eén lezing voor dit hele scherm, zonder timer. `failed` reist mee: een
    // mislukte lezing is iets anders dan een lezing die nog loopt, en zonder
    // poller komt die eerste niet meer terug.
    const { counts, makers, failed: countsFailed } = useStudioCounts({ poll: false });

    const ctx = studioGateContext({
        user, hasLicenseFeature, hasPermission, can, lockReason,
        entitlementsLoading, entitlementsError,
    });
    const sections = studioNavSections([...STUDIO_APPS, ...runtimeStudioApps], ctx);
    const groups = groupStudioApps(sections);

    // Runtime modules carry a locale-aware label() fn; built-ins an i18n key.
    // Beide antwoorden staan in studioNav.js, zodat een sectie hier niet
    // anders kan heten dan op de rail of in "Laatst bewerkt".
    const labelOf = (app) => studioSectionLabel(app, t, locale);
    const descOf = (app) => (app.descKey ? t(app.descKey, app.descFallback) : null);

    return (
        <div className="h-full overflow-y-auto custom-scrollbar" data-testid="studio-start">
            <div className="max-w-4xl mx-auto px-6 py-8">
                {/* Wie hier bouwt, wat je nieuw kunt maken, en "beschrijf wat
                    je wilt" — dat laatste sinds H4 een echt paneel, dat de kop
                    zelf draagt (studioAi/DescribeItPanel). Dezelfde gegate
                    `sections` als de rest van dit scherm gaan mee, zodat het
                    paneel geen soort aanbiedt die hieronder gelockt staat. Het
                    makersgetal wordt op de server geteld — zie
                    StudioHomeHeader.jsx. */}
                <StudioHomeHeader user={user} sections={sections} onNavigate={onNavigate} makers={makers} />

                {/* What is asking for a person, above what there is to open.
                    Its own component because it is the one thing on this screen
                    that goes to the network, and because the rule it keeps —
                    "found nothing" is not "could not look" — is worth reading
                    on its own (attention/attentionChecks.js). */}
                <AttentionList user={user} hasFeature={hasLicenseFeature} onNavigate={onNavigate} />

                {/* Daarna waar je gebleven was. Dezelfde secties, dezelfde
                    gates: een lijst die deze persoon niet mag zien wordt niet
                    gevraagd, en een lijst die omvalt zegt dat (recent/). */}
                {/* `gatesResolved`: zolang de entitlements laden of omvielen
                    LAAT resolveStudioNav de gegate secties helemaal weg — dan
                    is "nog niets bewerkt" een geruststelling over zeven lijsten
                    die nooit gevraagd zijn. Onbekend versmalt. */}
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

                {/* Onderaan, want het is het antwoord op een tweede vraag: niet
                    "waar ga ik heen" maar "hoe passen deze dingen in elkaar".
                    Bewust een handgelegde legenda en geen levende org-brede
                    graph — de reden staat in map/studioMap.js en blijft staan. */}
                <StudioMap counts={counts} countsFailed={countsFailed} />
            </div>
        </div>
    );
}

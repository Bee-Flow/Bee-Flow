import { useRef } from 'react';
import { nOf } from './KnowledgeStudio/plural';
import { NewMenuButton, type NewMenuSection } from './NewMenu';
import DescribeItPanel from './studioAi/DescribeItPanel';
import { useStudioCounts } from '@/hooks/useStudioCounts';
import { useTranslation, type TranslateParams } from '@/hooks/useTranslation';

/**
 * The header of the Studio Start screen (Track H3, artboard 1b).
 *
 * Four things, and three of them are a promise that easily goes too far.
 *
 * ── “Organisation X · 12 makers” ─────────────────────────────────────────────
 *
 * The number comes from GET /api/studio/counts, where it is counted on the SERVER:
 * one collection of all owners across all counted kinds. It is not derived in the
 * client from the lists — those are paginated and gated, and then the header would
 * count something different from what is listed beneath it.
 *
 * What the number IS is stated in the tooltip, because it is narrower than the
 * header suggests: it is the owners of everything that THIS person may see
 * (routes/studio/counts.js omits every key you may not see, and counts per kind with
 * the scoping of the list itself). An organisation-wide makers count would be its own,
 * gated count on the server; that does not exist today and is not imitated here.
 *
 * Three values, three renderings — the difference between “zero” and “unknown” is
 * the core of this screen:
 *   unknown (not yet loaded, or the fetch fell over) → no sentence. Nothing is
 *      claimed until the answer is there — the same rule as the counts on the rail
 *   0  → “Nothing you can see here yet”, not “0 makers”: the latter reads as “nobody
 *      works here”, while the reader is standing there himself. And the sentence
 *      concerns VISIBILITY, not the place: 0 is also what you get when every kind is
 *      gated for this reader. A 0 that came from a FAILED count no longer exists —
 *      routes/studio/counts.js omits `makers` as soon as the answer is partial,
 *      exactly as it omits a counter
 *   1+ → the number, with singular and plural kept apart
 *
 * ── One request, no second poller ─────────────────────────────────────────
 *
 * The rail already polls /api/studio/counts every 30s. This header reads the same
 * answer ONCE (useStudioCounts with poll: false) — the server caches it for one
 * minute per (org, user), so usually the rail has already paid for it.
 *
 * ── “Building with AI” is here now ───────────────────────────────────────────
 *
 * Until H4, a placeholder stood in this place: a dotted card that said what it would
 * become and that it was not there yet. The reason for that has not lapsed but was
 * RESOLVED — a button that does nothing is worse than none, and a text box you cannot
 * type in is a broken control, so something clickable came only once something stood
 * behind it. That is now the case: studioAi/DescribeItPanel (variant 'inline') talks to
 * POST /api/studio/ai/route and then brings the reader to the EXISTING builder of the
 * chosen kind. The panel receives the same `sections` as the rest of this screen, so a
 * kind that this reader may not create also remains a sign there rather than becoming
 * a door.
 *
 * ONE panel on this screen, not two. The AI line of the “New” menu therefore gets its
 * own `onAi` that brings the user TO THIS panel (into view, cursor in the field)
 * instead of opening a second instance in a dialog. That is precisely what releases
 * that line from the Automations fallback: with its own `onAi` it follows this header,
 * and is no longer locked precisely when Automations is that (see AI_FALLBACK_SECTION
 * in NewMenu.jsx).
 *
 * What the panel does NOT do — creating several kinds at once — is stated in
 * studioAi/DescribeItPanel itself: that is H4b and awaits K8.
 *
 * ── The “New” menu ────────────────────────────────────────────────────────
 *
 * The split button from NewMenu.jsx, mounted here for the first time (“Track H places
 * it in the Studio header”). It receives the same `sections` as the rest of this
 * screen — the already gated rows — so a locked kind stays in the menu with the hint
 * that the rail also shows, instead of disappearing.
 */

/** De ene regel onder "Start": wie hier bouwt, of anders waar je bent. */
interface MetaLineProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    orgName: string | null;
    makers: number | null;
}

function MetaLine({ t, orgName, makers }: MetaLineProps) {
    const makersPhrase = makers === null
        ? null
        : (makers === 0
            ? t('studio.makers_none', 'Nothing you can see here yet')
            : nOf(t, 'studio.makers', makers, '{count} maker', '{count} makers'));

    if (!orgName && !makersPhrase) {
        // Nothing to report yet: the header remains one sentence, not a bare word.
        return (
            <p className="mt-1 text-[13px] text-[var(--text-tertiary)]" data-testid="studio-home-desc">
                {t('studio.start.desc', 'Everything you build, in one place')}
            </p>
        );
    }
    return (
        <p className="mt-1 text-[13px] text-[var(--text-tertiary)]" data-testid="studio-home-meta">
            {orgName && <span data-testid="studio-home-org">{orgName}</span>}
            {orgName && makersPhrase && <span aria-hidden="true"> · </span>}
            {makersPhrase && (
                <span
                    data-testid="studio-home-makers"
                    // Exactly what is counted. The header says “makers”; this says which makers,
                    // and that is narrower than the whole organisation.
                    title={t('studio.makers_hint', 'Everyone who owns something you can see in Studio.')}
                >
                    {makersPhrase}
                </span>
            )}
        </p>
    );
}

interface StudioHomeHeaderProps {
    user?: { id?: string; organization?: { id: string; name: string }; permissions?: string[] } | null;
    sections?: NewMenuSection[] | null;
    onNavigate?: ((target: string) => void) | null;
    makers?: number | null;
}

export default function StudioHomeHeader({
    user = null, sections = null, onNavigate = null, makers: makersProp,
}: StudioHomeHeaderProps) {
    const { t } = useTranslation();
    // `undefined` = nobody above us owns the number, so we read it ourselves: once,
    // no timer (the rail already polls this endpoint — see the hook). If the parent DOES
    // pass it along, there is ONE read on this screen instead of two that can diverge;
    // `null` from the parent is an answer (“unknown”), and that is something other
    // than no prop.
    const ownsMakers = makersProp === undefined;
    const { makers: fetched } = useStudioCounts({ enabled: ownsMakers, poll: false });
    const makers = ownsMakers ? fetched : makersProp;

    const rawOrgName = user?.organization?.name;
    const orgName = typeof rawOrgName === 'string' && rawOrgName.trim() ? rawOrgName.trim() : null;

    // The AI line of the “New” menu lands on the panel that is already here: bring it
    // into view and place the cursor in the field. No second instance of the same
    // panel, and therefore also no second answer on one screen.
    const aiRef = useRef<HTMLDivElement>(null);
    const focusAi = () => {
        const host = aiRef.current;
        if (!host) return;
        // Not every environment knows scrollIntoView (jsdom for example); it is the
        // guidance, not the action, so it may be absent.
        if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ block: 'nearest' });
        const field = host.querySelector<HTMLElement>('textarea, input');
        if (field && typeof field.focus === 'function') field.focus();
    };

    return (
        <header data-testid="studio-home-header">
            <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                    <h1 className="text-[22px] font-semibold text-[var(--text-primary)]">
                        {t('studio.start.title', 'Start')}
                    </h1>
                    <MetaLine t={t} orgName={orgName} makers={makers} />
                </div>
                <div className="flex-shrink-0 pt-1">
                    <NewMenuButton sections={sections} onNavigate={onNavigate} user={user} onAi={focusAi} />
                </div>
            </div>
            <div className="mt-4" ref={aiRef}>
                <DescribeItPanel sections={sections} onNavigate={onNavigate} user={user} variant="inline" />
            </div>
        </header>
    );
}

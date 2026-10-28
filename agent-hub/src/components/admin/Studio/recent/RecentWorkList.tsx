import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RECENT_LIMIT, recentSourcesFor, runRecentWork, statusLabel, statuslessKinds } from '@/api/recentWork';
import { useTranslation } from '@/hooks/useTranslation';
import { formatRelativeTime } from '@/utils/dateFormatters';
import { kindColorVar, kindIcon } from '@/components/shared/kindColors';
import { nOf } from '../KnowledgeStudio/plural';
import { studioSectionLabel } from '../studioNav';
import type { TranslateFn } from '@/hooks/useTranslation';

type RecentWorkState = Awaited<ReturnType<typeof runRecentWork>>;
type RecentEntry = RecentWorkState['items'][number];

/** The part of a Studio nav row the list reads. */
interface StudioNavSection {
    id: string;
}

interface StatusWordProps {
    t: TranslateFn;
    status: string;
    testId: string;
}

interface RecentRowProps {
    t: TranslateFn;
    locale: string;
    entry: RecentEntry;
    icon: React.ReactNode;
    onOpen: (() => void) | null;
}

interface StatusLineProps {
    t: TranslateFn;
    total: number;
    complete: boolean;
    missing: string[];
    gatesUnknown: boolean;
    unsupported: string[];
}

interface RecentWorkListProps {
    sections?: StudioNavSection[] | null;
    onNavigate?: ((path: string) => void) | null;
    limit?: number;
    gatesResolved?: boolean;
}

/**
 * “Last edited” — the second list on the Studio Start screen (Track H3).
 *
 * What appears on a row, and where it comes from, is in recentWork.js; this file draws
 * it. Three things here are worth reading.
 *
 * ── One word per row, and two ways to have none ───────────────────────────
 *
 * Six of the nine lists carry a status; three do not (knowledge bases, skills,
 * solutions). A row from those three gets NO green tick and also no empty place — both
 * read as “all fine” — but the word “No status” in neutral ink, with the reason in the
 * tooltip and one sentence beneath the list. A row from the other six whose field was
 * missing says “Status unknown”: a different fact, a different sentence.
 *
 * ── Short is not the same as done ─────────────────────────────────────────
 *
 * An empty list has two causes, and only one of them is good news. `complete` (no
 * single section that fell over) is the only right to say “nothing edited yet”;
 * otherwise it says that not everywhere could be looked, with the names of the lists
 * that did not take part. The same rule as AttentionList beside it, and for the same
 * reason.
 *
 * A section that the server REFUSES (403), or that sits behind a licence, is not a gap:
 * there is nothing for this person to edit there. That is silent, because a warning
 * that everyone sees every day teaches everyone to ignore warnings.
 *
 * Two things ARE that, and both are invisible if you do not ask for them: the gates
 * that do not yet have an answer (`gatesResolved` false — then the gated sections are
 * not even in the list, so they cannot be missed) and a runtime module that this build
 * cannot read. Both get a sentence, and both prevent “nothing edited yet”.
 *
 * ── Fetch once, on opening ────────────────────────────────────────────────
 *
 * No timer. The rail already polls the counts; this list costs at most nine requests,
 * and those belong to opening the screen, not to every half minute that it stays open.
 */

/** The status word of a row: always a word, never an empty box. */
function StatusWord({ t, status, testId }: StatusWordProps) {
    const label = statusLabel(status);
    return (
        <span
            data-testid={testId}
            data-status={status}
            title={label.hintFallback ? t(label.hintKey, label.hintFallback) : undefined}
            className="flex-shrink-0 text-[11px] font-medium"
            style={{ color: label.tone }}
        >
            {t(label.key, label.fallback)}
        </span>
    );
}

/**
 * One row: what it is about, in what state it is, and when it changed.
 *
 * The glyph arrives as a node, not as a kind name — so the lookup in the register sits
 * in the same place as in AttentionList beside it, and this row draws only that.
 */
function RecentRow({ t, locale, entry, icon, onOpen }: RecentRowProps) {
    const when = entry.at === null ? null : formatRelativeTime(entry.updatedAt, { locale });
    return (
        <button
            type="button"
            onClick={onOpen || undefined}
            data-testid={`studio-recent-item-${entry.key}`}
            data-kind={entry.kind || undefined}
            className="w-full flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
        >
            {icon}
            <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                        {entry.name || t('studio.recent.untitled', 'Untitled')}
                    </span>
                    <StatusWord t={t} status={entry.status} testId={`studio-recent-status-${entry.key}`} />
                    {/* A time only if there was a readable time. “just now” above an unreadable timestamp
                        is an invention. */}
                    {when && (
                        <span className="flex-shrink-0 text-[11px] text-[var(--text-tertiary)]" data-testid={`studio-recent-when-${entry.key}`}>
                            {when}
                        </span>
                    )}
                </span>
                {entry.description && (
                    <span className="block truncate text-[11.5px] leading-snug mt-0.5 text-[var(--text-tertiary)]">
                        {entry.description}
                    </span>
                )}
            </span>
        </button>
    );
}

/**
 * The sentence under the heading. Precisely one of three, and the first two are the pair
 * that this screen must keep apart.
 */
function StatusLine({ t, total, complete, missing, gatesUnknown, unsupported }: StatusLineProps) {
    // Eén of meer lijsten, met hun eigen naam erbij. Meervoud via de sleutel,
    // nooit "list(s)" (KnowledgeStudio/plural.js).
    const unreadable = () => nOf(
        t, 'studio.recent.unreadable', missing.length,
        'Could not read this list: {sections}',
        'Could not read these lists: {sections}',
        { sections: missing.join(', ') },
    );
    // The gates themselves had no answer yet: the gated sections were not there, so they
    // are not to be reported as “refused” — only as not asked. Without this sentence,
    // that is silence with a reassurance on it.
    const gatesLine = () => t(
        'studio.recent.gates_unknown',
        'Some lists were not asked for yet because your access is still being checked.',
    );
    // Geen meervoudspaar: de zin somt namen op, dus hij leest hetzelfde voor
    // één en voor drie.
    const unsupportedLine = () => t(
        'studio.recent.unsupported',
        'This version cannot list what is in {sections}.',
        { sections: unsupported.join(', ') },
    );
    const details = [
        missing.length > 0 ? unreadable() : '',
        gatesUnknown ? gatesLine() : '',
        unsupported.length > 0 ? unsupportedLine() : '',
    ].filter(Boolean).join(' ');

    if (total === 0 && complete) {
        return (
            <p className="mt-1.5 text-[12px] text-[var(--text-tertiary)]" data-testid="studio-recent-empty">
                {t('studio.recent.empty', 'Nothing edited yet.')}
            </p>
        );
    }
    if (total === 0) {
        return (
            <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]" data-testid="studio-recent-empty-unread">
                {t('studio.recent.empty_unreadable', 'Some lists could not be read, so this is not the whole picture — not "nothing here".')}
                {details ? ` ${details}` : ''}
            </p>
        );
    }
    if (!complete) {
        return (
            <p className="mt-1.5 text-[12px] text-[var(--text-secondary)]" data-testid="studio-recent-partial">
                {details}
            </p>
        );
    }
    return null;
}

export default function RecentWorkList({
    sections = null, onNavigate = null, limit = RECENT_LIMIT, gatesResolved = true,
}: RecentWorkListProps) {
    const { t, locale } = useTranslation();
    const [state, setState] = useState<RecentWorkState | null>(null);

    // The sections are a new array on every render; the ids in them are not. The fetch
    // depends on those ids, so a render of the parent does not trigger a second round of requests.
    const asked = useMemo(() => recentSourcesFor(sections).asked, [sections]);
    const askedKey = asked.map((a) => a.sectionId).join(',');

    // Tracked in an effect, not during render: a ref written during rendering is a render with a side effect. It sits ABOVE the effect that reads it — that is the order they run in.
    const sectionsRef = useRef(sections);
    useEffect(() => { sectionsRef.current = sections; });

    useEffect(() => {
        let cancelled = false;
        (async () => {
            const result = await runRecentWork(sectionsRef.current, { limit, gatesResolved });
            if (!cancelled) setState(result);
        })();
        return () => { cancelled = true; };
    }, [askedKey, limit, gatesResolved]);

    // Before the first answer, nothing is claimed — no empty list, no reassurance. Same rule as the counts on the rail.
    if (!state) return null;

    const { items, unavailable, complete, unsupported = [] } = state;
    // The names of the lists that could not be read, from the same register as the rail — "Agents" here and "Agents" there.
    const byId = new Map<string, StudioNavSection>((sections || []).filter(Boolean).map((app) => [app.id, app]));
    const nameOf = (id: string) => studioSectionLabel(byId.get(id), t, locale) || id;
    // 'gates' is not a section but the missing answer to the question WHICH sections there are; it therefore gets its own sentence and no name in the row.
    const gatesUnknown = unavailable.includes('gates');
    const missing = unavailable.filter((id) => id !== 'gates').map(nameOf);
    const statusless = statuslessKinds(items);

    return (
        <section className="mt-6 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3" data-testid="studio-recent">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)]">
                {t('studio.recent.title', 'Recently edited')}
            </h2>

            <StatusLine
                t={t} total={items.length} complete={complete} missing={missing}
                gatesUnknown={gatesUnknown} unsupported={unsupported.map(nameOf)}
            />

            {items.length > 0 && (
                <div className="mt-2 -mx-1">
                    {items.map((entry) => {
                        const KindIcon = kindIcon(entry.kind);
                        return (
                            <RecentRow
                                key={entry.key}
                                t={t}
                                locale={locale}
                                entry={entry}
                                icon={KindIcon
                                    ? <KindIcon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: kindColorVar(entry.kind) }} strokeWidth={1.75} aria-hidden="true" />
                                    : null}
                                onOpen={onNavigate ? () => onNavigate(entry.path) : null}
                            />
                        );
                    })}
                </div>
            )}

            {/* Without this sentence a row with "No status" is an empty spot with no explanation — and that is exactly what this screen must not show. */}
            {statusless.length > 0 && (
                <p className="mt-1.5 text-[11.5px] text-[var(--text-tertiary)]" data-testid="studio-recent-statusless">
                    {t('studio.recent.statusless', 'Some kinds do not report a status in this list, so none is shown for them.')}
                </p>
            )}
        </section>
    );
}

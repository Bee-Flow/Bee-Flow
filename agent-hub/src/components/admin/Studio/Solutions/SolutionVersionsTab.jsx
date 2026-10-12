import { AlertTriangle, HelpCircle, Loader2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { kindBarClass, kindInkClass } from './kindBar';
import { groupNoteRows, noteRowsOf, readReleases } from './releaseModel';
import { Strip } from './solutionNotices';
import { useTranslation } from '../../../../hooks/useTranslation';
import { formatRelative } from '../../../projects/relativeTime';
import { kindIcon, kindOf } from '../../../shared/kindColors';
import { nOf } from '../KnowledgeStudio/plural';

/**
 * Versies — de publicatiegeschiedenis van deze Oplossing, in twee weergaven.
 *
 *   WAT VERANDERT   één versie, per entiteit: toegevoegd, gewijzigd,
 *                   ongewijzigd. Dat is de boolean diff uit
 *                   projects/packaging/releaseNotes.js — een hashvergelijking
 *                   tussen manifest v(n-1) en v(n), zonder modelaanroep.
 *   ALLE VERSIES    de lijst zelf: welk nummer, wanneer, en hoeveel er in die
 *                   publicatie veranderde. Klikken opent hem in de eerste
 *                   weergave.
 *
 * ── De zin kan ontbreken; de diff niet ─────────────────────────────────────
 *
 * Boven op de boolean diff schrijft een fast-tier-model één regel per gewijzigde
 * entiteit. Die laag mag omvallen — geen provider, een time-out, een weigering —
 * en dan blijft `text` null. DAT MAG DEZE TAB NIET LEEG MAKEN: de diff is er
 * gewoon, hij is exact, en hij is het antwoord op "wat is er anders". Een rij
 * zonder zin toont dus de rij, met een regel die zegt dat er geen samenvatting
 * geschreven kon worden. `change: 'changed'` met `text: null` betekent "geen
 * woorden", `change: 'unchanged'` betekent "geen nieuws" — die twee zien er
 * hier nooit hetzelfde uit.
 *
 * En een versie waarvoor helemaal GEEN diff is vastgelegd (een publicatie van
 * vóór de release-tabel) zegt dát — niet "er is niets veranderd".
 */

/** Wat de segmented control aanbiedt. Twee weergaven, één keuze. */
const VIEWS = [
    { id: 'changes', labelKey: 'solutions.versions_view_changes', fallback: 'What changed' },
    { id: 'all', labelKey: 'solutions.versions_view_all', fallback: 'All versions' },
];

/**
 * Het pictogram van een soort, als ELEMENT.
 *
 * Een gewone helper en geen component — hetzelfde als `renderGlyph` in
 * StudioSectionHeader — want een `const Icon = ...` in een componentlichaam
 * leest voor de linter als een component die tijdens het renderen ontstaat.
 */
function glyphFor(kind) {
    const Icon = kindIcon(kindOf(kind));
    if (!Icon) return null;
    return <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${kindInkClass(kind)}`} aria-hidden="true" />;
}

/** The change chip: the word and the colour both say what happened. */
const CHIP = {
    added: ['solutions.release_chip_added', 'Added', 'text-[var(--success)] border-[var(--success)]'],
    changed: ['solutions.release_chip_changed', 'Changed', 'text-[var(--warning)] border-[var(--warning)]'],
    unchanged: ['solutions.release_chip_unchanged', 'Unchanged', 'text-[var(--text-tertiary)] border-[var(--border-subtle)]'],
};
function ChangeChip({ change }) {
    const { t } = useTranslation();
    const c = CHIP[change];
    if (!c) return null;
    return (
        <span data-testid="version-change-chip"
              className={`flex-shrink-0 px-2 py-0.5 rounded-full border text-[11px] font-medium ${c[2]}`}>
            {t(c[0], c[1])}
        </span>
    );
}

/** Eén entiteitsregel van de diff: pictogram, naam, en de zin als die er is. */
function NoteRow({ row }) {
    const { t } = useTranslation();
    return (
        <li className={`flex items-start gap-2.5 px-3 py-2.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] border-l-[3px] bg-[var(--bg-secondary)] ${kindBarClass(row.kind)}`}
            data-testid="version-note-row">
            {glyphFor(row.kind)}
            <span className="flex-1 min-w-0">
                <span className="block text-sm text-[var(--text-primary)] break-words">{row.name}</span>
                {row.text && (
                    <span className="block text-xs mt-0.5 text-[var(--text-secondary)]">{row.text}</span>
                )}
                {/* De gewijzigde rij zónder zin. De rij blijft staan — hij is het
                    exacte antwoord — en dit is de enige plek die zegt waarom er
                    geen woorden bij staan. */}
                {row.summaryMissing && (
                    <span className="block text-xs mt-0.5 text-[var(--text-tertiary)]" data-testid="version-note-nosummary">
                        {t('solutions.release_no_summary', 'Changed — a one-line summary could not be written for this one.')}
                    </span>
                )}
            </span>
            <ChangeChip change={row.change} />
        </li>
    );
}

function NoteGroup({ rows, title, testId }) {
    if (rows.length === 0) return null;
    return (
        <div data-testid={testId}>
            <h3 className="text-sm font-medium mb-2 text-[var(--text-primary)]">{title}</h3>
            <ul className="space-y-1.5">
                {rows.map((row, i) => <NoteRow key={`${row.ref}-${i}`} row={row} />)}
            </ul>
        </div>
    );
}

/** De diff van één versie. */
function ChangesView({ release }) {
    const { t } = useTranslation();
    const note = noteRowsOf(release);

    // Geen vastgelegde diff. NIET hetzelfde als "niets veranderd", en dus ook
    // geen lege lijst.
    if (note.state === 'unrecorded') {
        return (
            <Strip tone="var(--warning)" icon={AlertTriangle} testId="version-unrecorded">
                {t('solutions.release_unrecorded',
                    'No record of what changed was kept for this version, so this is not "nothing changed".')}
            </Strip>
        );
    }

    const groups = groupNoteRows(note.rows);
    return (
        <div className="space-y-5">
            {note.textsDropped && (
                <Strip tone="var(--text-tertiary)" icon={HelpCircle} testId="version-texts-dropped">
                    {t('solutions.release_texts_dropped',
                        'The written summaries were left out because the note was too large. The list below is still exact.')}
                </Strip>
            )}
            {note.rows.length === 0 && (
                <Strip tone="var(--text-tertiary)" icon={HelpCircle} testId="version-empty-diff">
                    {t('solutions.release_carries_nothing', 'This version carries nothing that can be listed.')}
                </Strip>
            )}

            <NoteGroup rows={groups.changed} testId="version-group-changed"
                       title={nOf(t, 'solutions.release_changed', groups.changed.length,
                           '{count} thing changed', '{count} things changed')} />
            <NoteGroup rows={groups.added} testId="version-group-added"
                       title={nOf(t, 'solutions.release_added', groups.added.length,
                           '{count} thing is new in this version', '{count} things are new in this version')} />
            <NoteGroup rows={groups.unchanged} testId="version-group-unchanged"
                       title={nOf(t, 'solutions.release_unchanged', groups.unchanged.length,
                           '{count} thing is unchanged', '{count} things are unchanged')} />

            {note.omitted > 0 && (
                <p className="text-xs text-[var(--text-tertiary)]" data-testid="version-omitted">
                    {nOf(t, 'solutions.release_omitted', note.omitted,
                        '{count} more entry was left out of the note to keep it within its size limit.',
                        '{count} more entries were left out of the note to keep it within its size limit.')}
                </p>
            )}
            {groups.unreadable > 0 && (
                <p className="text-xs text-[var(--text-tertiary)]" data-testid="version-unreadable-rows">
                    {nOf(t, 'solutions.release_unplaceable', groups.unreadable,
                        '{count} entry could not be placed and is not counted above.',
                        '{count} entries could not be placed and are not counted above.')}
                </p>
            )}
        </div>
    );
}

/** De lijst. Een tijdlijn: één rij per publicatie, met de telling van die publicatie erbij. */
function AllVersionsView({ releases, selectedId, onSelect }) {
    const { t } = useTranslation();
    return (
        <ol className="relative ml-2 border-l border-[var(--border-subtle)] space-y-2">
            {releases.map((release) => {
                const note = noteRowsOf(release);
                const groups = groupNoteRows(note.rows);
                const selected = release.id === selectedId;
                return (
                    <li key={release.id} className="relative pl-5">
                        <span aria-hidden="true"
                              className={`absolute -left-[5px] top-4 w-2.5 h-2.5 rounded-full border-2 border-[var(--bg-primary)] ${selected ? 'bg-[var(--accent-primary)]' : 'bg-[var(--text-tertiary)]'}`} />
                        <button
                            onClick={() => onSelect(release.id)}
                            data-testid="version-row"
                            aria-current={selected ? 'true' : undefined}
                            className={`w-full min-h-[44px] text-left flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 rounded-[var(--radius-md)] border bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${selected ? 'border-[var(--accent-primary)]' : 'border-[var(--border-subtle)]'}`}
                        >
                            <span className="text-sm font-medium text-[var(--text-primary)]">
                                {release.version === null
                                    ? t('solutions.release_version_unknown', 'Version unknown')
                                    : t('solutions.release_version', 'v{version}', { version: release.version })}
                            </span>
                            <span className="text-xs text-[var(--text-tertiary)]">
                                {formatRelative(release.publishedAt)}
                            </span>
                            <span className="flex-1" />
                            {note.state === 'unrecorded' ? (
                                <span className="text-xs text-[var(--text-tertiary)]">
                                    {t('solutions.release_row_unrecorded', 'not recorded')}
                                </span>
                            ) : (
                                <span className="flex flex-wrap items-center gap-1.5 text-[11px]" data-testid="version-row-counts">
                                    {groups.added.length > 0 && (
                                        <span className="px-2 py-0.5 rounded-full border border-[var(--success)] text-[var(--success)]">
                                            {t('solutions.release_row_added', '+{count} added', { count: groups.added.length })}
                                        </span>
                                    )}
                                    {groups.changed.length > 0 && (
                                        <span className="px-2 py-0.5 rounded-full border border-[var(--warning)] text-[var(--warning)]">
                                            {t('solutions.release_row_changed', '{count} changed', { count: groups.changed.length })}
                                        </span>
                                    )}
                                    <span className="text-xs text-[var(--text-tertiary)]">
                                        {nOf(t, 'solutions.release_row_changes', groups.changed.length + groups.added.length,
                                            '{count} change', '{count} changes')}
                                    </span>
                                </span>
                            )}
                        </button>
                    </li>
                );
            })}
        </ol>
    );
}

export default function SolutionVersionsTab({ remote }) {
    const { t } = useTranslation();
    const [view, setView] = useState('changes');
    const [picked, setPicked] = useState(null);

    const { state, releases } = useMemo(() => readReleases(remote), [remote]);
    // De nieuwste is de standaard — dat is de versie die "wat verandert"
    // bedoelt. Een handmatige keuze wint, maar alleen zolang die versie er is.
    const selected = releases.find(r => r.id === picked) || releases[0] || null;

    if (state === 'loading') {
        return (
            <div className="flex items-center justify-center py-16 text-[var(--text-tertiary)]">
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    // Een mislukte lees is GEEN lege geschiedenis. Zonder deze regel zou een
    // Oplossing die wél gepubliceerd is er ongepubliceerd uitzien.
    if (state === 'unreadable') {
        return (
            <Strip tone="var(--error)" icon={AlertTriangle} testId="versions-unreadable">
                {t('solutions.release_unavailable',
                    'The release history could not be read, so this is not "there are none".')}
            </Strip>
        );
    }

    if (releases.length === 0) {
        return (
            <Strip tone="var(--text-tertiary)" icon={HelpCircle} testId="versions-none">
                {t('solutions.release_none', 'This Solution has not been published yet, so there are no versions.')}
            </Strip>
        );
    }

    return (
        <div className="space-y-4">
            <div className="inline-flex items-center gap-1 p-1 rounded-[var(--radius-md)] bg-[var(--bg-tertiary)]" role="tablist">
                {VIEWS.map(v => (
                    <button
                        key={v.id}
                        role="tab"
                        aria-selected={view === v.id}
                        onClick={() => setView(v.id)}
                        data-testid={`versions-view-${v.id}`}
                        className={`px-3 min-h-[44px] sm:min-h-8 rounded-[var(--radius-sm)] text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${view === v.id
                            ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)] shadow-sm'
                            : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}`}
                    >
                        {t(v.labelKey, v.fallback)}
                    </button>
                ))}
            </div>

            {view === 'changes' && <ChangesView release={selected} />}
            {view === 'all' && (
                <AllVersionsView
                    releases={releases}
                    selectedId={selected?.id || null}
                    onSelect={(id) => { setPicked(id); setView('changes'); }}
                />
            )}
        </div>
    );
}

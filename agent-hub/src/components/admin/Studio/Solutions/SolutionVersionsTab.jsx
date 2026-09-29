import { AlertTriangle, HelpCircle, Loader2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { groupNoteRows, noteRowsOf, readReleases } from './releaseModel';
import { useTranslation } from '../../../../hooks/useTranslation';
import { formatRelative } from '../../../projects/relativeTime';
import { Strip } from '../../../projects/solutionNotices';
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
    return <Icon className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />;
}

/** Eén entiteitsregel van de diff: pictogram, naam, en de zin als die er is. */
function NoteRow({ row }) {
    const { t } = useTranslation();
    return (
        <li className="flex items-start gap-2.5 px-3 py-2 rounded-lg" data-testid="version-note-row"
            style={{ background: 'var(--bg-secondary)' }}>
            {glyphFor(row.kind)}
            <span className="flex-1 min-w-0">
                <span className="block text-sm" style={{ color: 'var(--text-primary)' }}>{row.name}</span>
                {row.text && (
                    <span className="block text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{row.text}</span>
                )}
                {/* De gewijzigde rij zónder zin. De rij blijft staan — hij is het
                    exacte antwoord — en dit is de enige plek die zegt waarom er
                    geen woorden bij staan. */}
                {row.summaryMissing && (
                    <span className="block text-xs mt-0.5" data-testid="version-note-nosummary"
                          style={{ color: 'var(--text-tertiary)' }}>
                        {t('solutions.release_no_summary', 'Changed — a one-line summary could not be written for this one.')}
                    </span>
                )}
            </span>
        </li>
    );
}

function NoteGroup({ rows, title, testId }) {
    if (rows.length === 0) return null;
    return (
        <div data-testid={testId}>
            <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>{title}</h3>
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
                <p className="text-xs" data-testid="version-omitted" style={{ color: 'var(--text-tertiary)' }}>
                    {nOf(t, 'solutions.release_omitted', note.omitted,
                        '{count} more entry was left out of the note to keep it within its size limit.',
                        '{count} more entries were left out of the note to keep it within its size limit.')}
                </p>
            )}
            {groups.unreadable > 0 && (
                <p className="text-xs" data-testid="version-unreadable-rows" style={{ color: 'var(--text-tertiary)' }}>
                    {nOf(t, 'solutions.release_unplaceable', groups.unreadable,
                        '{count} entry could not be placed and is not counted above.',
                        '{count} entries could not be placed and are not counted above.')}
                </p>
            )}
        </div>
    );
}

/** De lijst. Één rij per publicatie, met de telling van die publicatie erbij. */
function AllVersionsView({ releases, selectedId, onSelect }) {
    const { t } = useTranslation();
    return (
        <ul className="space-y-1.5">
            {releases.map((release) => {
                const note = noteRowsOf(release);
                const groups = groupNoteRows(note.rows);
                const changes = groups.changed.length + groups.added.length;
                return (
                    <li key={release.id}>
                        <button
                            onClick={() => onSelect(release.id)}
                            data-testid="version-row"
                            aria-current={release.id === selectedId ? 'true' : undefined}
                            className="w-full text-left flex items-baseline gap-3 px-3 py-2 rounded-lg"
                            style={{
                                background: 'var(--bg-secondary)',
                                outline: release.id === selectedId ? '1px solid var(--border-default)' : 'none',
                            }}
                        >
                            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                                {release.version === null
                                    ? t('solutions.release_version_unknown', 'Version unknown')
                                    : t('solutions.release_version', 'v{version}', { version: release.version })}
                            </span>
                            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {formatRelative(release.publishedAt)}
                            </span>
                            <span className="flex-1" />
                            <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {note.state === 'unrecorded'
                                    ? t('solutions.release_row_unrecorded', 'not recorded')
                                    : nOf(t, 'solutions.release_row_changes', changes,
                                        '{count} change', '{count} changes')}
                            </span>
                        </button>
                    </li>
                );
            })}
        </ul>
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
            <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-tertiary)' }}>
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
            <div className="flex items-center gap-1" role="tablist">
                {VIEWS.map(v => (
                    <button
                        key={v.id}
                        role="tab"
                        aria-selected={view === v.id}
                        onClick={() => setView(v.id)}
                        data-testid={`versions-view-${v.id}`}
                        className="px-2.5 h-7 rounded-lg text-[13px]"
                        style={view === v.id
                            ? { background: 'var(--bg-secondary)', color: 'var(--text-primary)' }
                            : { color: 'var(--text-tertiary)' }}
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

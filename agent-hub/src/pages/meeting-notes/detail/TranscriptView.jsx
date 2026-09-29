import React, { useMemo, useState } from 'react';
import { CircleHelp, Gavel, ListChecks, MoreHorizontal, Search } from 'lucide-react';
import SpeakerLegend from './SpeakerLegend';
import TranscriptLineMenu from './TranscriptLineMenu';
import useTranslation from '../../../hooks/useTranslation';
import { formatDuration, formatSpeakerLabel } from '../lib/format';
import { buildSpeakerColorMap, segmentSpeakerId, speakerColor } from '../lib/playerData';
import { buildLineMarks } from '../lib/transcriptLines';

/**
 * The transcript tab (Meeting Notes artboard 1b, plan M4).
 *
 * Three columns — `110px | 1fr | 150px`:
 *
 *   when + who    the clock (seeks the player) and the speaker, colour-coded
 *                 from the same rank-based map the timeline and the legend use
 *   the sentence  with the search term highlighted
 *   what it is    the classification chips for this line, and the popover
 *
 * ── THE THIRD COLUMN IS A MIRROR, NOT A SECOND TRUTH ────────────────
 * A chip appears because an action item, a decision or a question on the note
 * carries this line's `segmentIndex` — `buildLineMarks` (lib/transcriptLines.js)
 * is an INDEX over the lists the note already holds. Nothing is counted here:
 * `buildFollowUpStats` (lib/insightsMetrics.js) remains the one place that
 * counts follow-ups, so the transcript can never disagree with the Insights
 * tab about how many there are.
 *
 * That also means the mirror is honest about deletion: remove the action on
 * the card and the chip goes with it, because there was only ever one fact.
 *
 * ── FILTERING KEEPS THE REAL LINE NUMBER ────────────────────────────
 * A filtered list is rendered, but every row carries its index in the
 * UNFILTERED `segments` array. The rendered position is a view; the anchor an
 * artifact stores has to survive the search box being cleared, and an artifact
 * written against a filtered index would point at a different sentence the
 * moment anybody typed in it.
 */

/** The three marks a line can carry — icon and colour per kind. */
const MARK_STYLE = Object.freeze({
    action: { Icon: ListChecks, color: 'var(--accent-primary)' },
    decision: { Icon: Gavel, color: 'var(--success)' },
    question: { Icon: CircleHelp, color: 'var(--warning)' },
});

export default function TranscriptView({
    segments = [],
    speakers = [],
    fullText = '',
    meeting = null,
    onSeek,
    onEditSpeakers,
    onAddLineAction = null,
    onAddLineDecision = null,
}) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [speakerFilter, setSpeakerFilter] = useState(null);
    const [selected, setSelected] = useState(null);   // index into `segments`
    // The open popover, as the line it belongs to AND the button it hangs off.
    // The element is captured in the click handler rather than kept in a map
    // of refs read during render: AnchoredMenu only ever reads `.current`, and
    // a ref per line would be one ref per sentence of a two-hour meeting.
    const [menu, setMenu] = useState(null);           // { index, el }
    // Same rank-based assignment the timeline rows and legend use — one color
    // per person across every surface.
    const colorMap = useMemo(() => buildSpeakerColorMap(speakers), [speakers]);
    const marks = useMemo(() => buildLineMarks(meeting), [meeting]);

    const filtered = useMemo(() => {
        const q = query.toLowerCase();
        // The index rides along, so a row always knows which line of the
        // meeting it is — not which row of the filtered view.
        return segments
            .map((seg, index) => ({ seg, index }))
            .filter(({ seg }) => (!speakerFilter || (seg.speaker || seg.speakerId) === speakerFilter))
            .filter(({ seg }) => (!q || (seg.text || '').toLowerCase().includes(q)));
    }, [segments, speakerFilter, query]);

    if (segments.length === 0) {
        return (
            <div className="rounded-xl border px-4 py-6 text-sm whitespace-pre-wrap" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}>
                {fullText || t('meetings.transcript_none', 'No transcript available.')}
            </div>
        );
    }

    const openSegment = menu ? segments[menu.index] : null;

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[200px]">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder={t('meetings.transcript_search', 'Search transcript…')}
                        className="w-full pl-9 pr-3 py-2 rounded-lg text-sm border outline-none"
                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                    />
                </div>
                <SpeakerLegend speakers={speakers} colorMap={colorMap} activeId={speakerFilter} onSelect={setSpeakerFilter} onEdit={onEditSpeakers} />
            </div>
            <div className="rounded-xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                <ul className="divide-y max-h-[600px] overflow-auto" style={{ borderColor: 'var(--border-subtle)' }}>
                    {filtered.length === 0 && (
                        <li className="px-4 py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                            {t('meetings.transcript_no_matches', 'No matching segments.')}
                        </li>
                    )}
                    {filtered.map(({ seg, index }) => (
                        <TranscriptRow
                            key={index}
                            segment={seg}
                            index={index}
                            query={query}
                            color={speakerColor(colorMap, segmentSpeakerId(seg))}
                            marks={marks.get(index) || null}
                            selected={selected === index}
                            menuOpen={menu?.index === index}
                            onSelect={() => setSelected(index)}
                            onOpenMenu={(el) => { setSelected(index); setMenu({ index, el }); }}
                            onSeek={onSeek}
                            t={t}
                        />
                    ))}
                </ul>
            </div>
            {/* ONE menu for the whole list. A popover per row would mount a
                portal, a document listener and three empty branch lists for
                every line of a two-hour meeting. */}
            {openSegment && (
                <TranscriptLineMenu
                    open
                    onClose={() => setMenu(null)}
                    anchorRef={{ current: menu.el }}
                    segment={openSegment}
                    segmentIndex={menu.index}
                    speakerLabel={formatSpeakerLabel(segmentSpeakerId(openSegment))}
                    meeting={meeting}
                    onAddAction={onAddLineAction}
                    onAddDecision={onAddLineDecision}
                />
            )}
        </div>
    );
}

function TranscriptRow({ segment, index, query, color, marks, selected, menuOpen, onSelect, onOpenMenu, onSeek, t }) {
    // The line's tint follows its FIRST mark: a line that is both an action
    // and a decision is tinted once, by the first kind in LINE_KINDS order, so
    // two marks never mix into a colour that means neither.
    const lead = marks?.[0] ? MARK_STYLE[marks[0].kind] : null;
    return (
        <li
            data-testid="transcript-row"
            data-segment-index={index}
            onClick={onSelect}
            className="grid grid-cols-[110px_1fr_150px] gap-3 px-4 py-2.5"
            style={{
                background: lead ? `color-mix(in srgb, ${lead.color} 7%, transparent)` : undefined,
                // The canvas's "this one" outline (index.css @keyframes
                // bf-node-pulse), which animates outline-color only — so
                // selecting a line cannot shift the lines under the cursor.
                // --bf-pulse-color gets the same token the outline does; the
                // keyframe overrides the shorthand's colour, and without it
                // the pulse would breathe a different colour than the border.
                outline: selected ? '2px solid var(--accent-primary)' : 'none',
                outlineOffset: -2,
                animation: selected ? 'bf-node-pulse 1.6s ease-in-out infinite' : undefined,
                '--bf-pulse-color': 'var(--accent-primary)',
            }}
        >
            <div className="flex flex-col text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <button
                    type="button"
                    onClick={() => onSeek?.(segment.start || 0)}
                    className="font-mono hover:text-[var(--accent-primary)] text-left transition-colors"
                >
                    {formatDuration(segment.start || 0)}
                </button>
                <span className="inline-flex items-center gap-1 mt-0.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                    <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
                        {formatSpeakerLabel(segmentSpeakerId(segment))}
                    </span>
                </span>
            </div>
            <div className="text-sm leading-relaxed" style={{ color: 'var(--text-primary)' }}>
                {highlight(segment.text || '', query)}
            </div>
            <div className="flex items-start justify-end gap-1 flex-wrap">
                {(marks || []).map((mark) => <MarkChip key={`${mark.kind}-${mark.id}`} mark={mark} t={t} />)}
                <button
                    type="button"
                    onClick={(e) => onOpenMenu(e.currentTarget)}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    data-testid="transcript-line-menu-trigger"
                    aria-label={t('meetings.line_menu', 'What is this line?')}
                    className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] transition-colors shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                >
                    <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
                </button>
            </div>
        </li>
    );
}

/** What came out of this line, in one chip. */
function MarkChip({ mark, t }) {
    const skin = MARK_STYLE[mark.kind];
    if (!skin) return null;
    const { Icon, color } = skin;
    // The chip and the popover row say the same word about the same thing, so
    // they share the key rather than growing a second one with identical text.
    // The grammar decision sits around the KEY, never inside a sentence: an
    // answered question is a different label, not a suffix bolted onto one.
    const label = {
        action: t('meetings.line_action', 'Action'),
        decision: t('meetings.line_decision', 'Decision'),
        question: mark.open === false
            ? t('meetings.line_question_answered', 'Answered')
            : t('meetings.line_question', 'Question'),
    }[mark.kind];
    return (
        <span
            data-testid={`line-mark-${mark.kind}`}
            title={mark.text || label}
            className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full max-w-full"
            style={{ background: `color-mix(in srgb, ${color} 15%, transparent)`, color }}
        >
            <Icon className="w-2.5 h-2.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{label}</span>
        </span>
    );
}

function highlight(text, query) {
    if (!query) return text;
    try {
        const parts = text.split(new RegExp(`(${escapeRegex(query)})`, 'ig'));
        return parts.map((p, i) => (
            p.toLowerCase() === query.toLowerCase()
                ? <mark key={i} style={{ background: 'rgba(255, 212, 0, 0.35)', color: 'inherit', borderRadius: 2, padding: '0 2px' }}>{p}</mark>
                : <React.Fragment key={i}>{p}</React.Fragment>
        ));
    } catch (_) { return text; }
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

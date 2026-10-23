import React, { useEffect, useMemo, useState } from 'react';
import { Search, Check, Clock, Users, FileAudio, Loader2 } from 'lucide-react';
import * as api from '../../pages/meeting-notes/lib/transcriptionsApi';
import { formatDuration, formatRelativeDate } from '../../pages/meeting-notes/lib/format';

export interface PickerMeeting {
    id: string;
    title?: string;
    tags?: unknown[];
    createdAt: string;
    durationSeconds: number;
    speakerCount: number;
}

interface MeetingPreview {
    summary: string;
    title?: string;
}

interface MeetingPickerProps {
    mode?: 'single' | 'multi';
    value?: string[];
    onChange?: (ids: string[]) => void;
    onSelect?: (meeting: PickerMeeting) => void;
    autoLoad?: boolean;
    placeholder?: string;
    emptyAction?: React.ReactNode;
}

/**
 * Shared meeting picker used by NotebookSources (single-add) and TemplatesPage
 * (multi-select context). One implementation, two modes — keeps the UX
 * consistent across the app.
 *
 * Props:
 *   - mode: 'single' | 'multi'
 *   - value (multi): array of meeting IDs currently selected
 *   - onChange (multi): receives new array of IDs
 *   - onSelect (single): receives a single meeting object on row click
 *   - autoLoad: defaults to true; set false to render the inline form factor
 *   - emptyAction: optional CTA shown when no meetings exist
 */
export default function MeetingPicker({
    mode = 'multi',
    value = [],
    onChange,
    onSelect,
    autoLoad = true,
    placeholder = 'Search meeting notes…',
    emptyAction,
}: MeetingPickerProps) {
    const [meetings, setMeetings] = useState<PickerMeeting[]>([]);
    const [loading, setLoading] = useState(autoLoad);
    const [error, setError] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const [hoveredId, setHoveredId] = useState<string | null>(null);
    const [previews, setPreviews] = useState<Record<string, MeetingPreview>>({}); // id -> { summary, title }

    useEffect(() => {
        if (!autoLoad) return;
        setLoading(true);
        api.listTranscriptions()
            .then(setMeetings)
            .catch((e: Error) => setError(e.message))
            .finally(() => setLoading(false));
    }, [autoLoad]);

    useEffect(() => {
        if (!hoveredId || previews[hoveredId]) return;
        let cancelled = false;
        api.getTranscription(hoveredId)
            .then((d: { summary?: string; title?: string }) => { if (!cancelled) setPreviews((p: Record<string, MeetingPreview>) => ({ ...p, [hoveredId]: { summary: d.summary || '', title: d.title } })); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [hoveredId, previews]);

    const filtered = useMemo(() => {
        if (!query) return meetings;
        const q = query.toLowerCase();
        return meetings.filter((m: PickerMeeting) => (m.title || '').toLowerCase().includes(q) || (m.tags || []).some((t: unknown) => String(t).toLowerCase().includes(q)));
    }, [meetings, query]);

    const toggle = (m: PickerMeeting) => {
        if (mode === 'single') { onSelect?.(m); return; }
        if (!onChange) return;
        const set = new Set(value);
        if (set.has(m.id)) set.delete(m.id);
        else set.add(m.id);
        onChange(Array.from(set));
    };

    return (
        <div className="rounded-2xl border overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="relative px-3 py-2 border-b border-[var(--border-subtle)]">
                <Search className="w-4 h-4 absolute left-5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                    value={query}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                    placeholder={placeholder}
                    className="w-full pl-7 pr-3 py-1.5 bg-transparent outline-none text-sm"
                    style={{ color: 'var(--text-primary)' }}
                />
            </div>
            <div className="max-h-72 overflow-auto">
                {loading && (
                    <div className="flex items-center justify-center py-6">
                        <Loader2 className="w-4 h-4 animate-spin text-[var(--text-muted)]" />
                    </div>
                )}
                {error && (
                    <div className="px-4 py-6 text-xs text-rose-500">{error}</div>
                )}
                {!loading && !error && filtered.length === 0 && (
                    <div className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
                        {meetings.length === 0 ? 'No meeting notes yet.' : 'No meetings match your search.'}
                        {emptyAction && (
                            <div className="mt-3">{emptyAction}</div>
                        )}
                    </div>
                )}
                {filtered.map((m: PickerMeeting) => {
                    const selected = value.includes(m.id);
                    const preview = previews[m.id];
                    return (
                        <div
                            key={m.id}
                            className="relative"
                            onMouseEnter={() => setHoveredId(m.id)}
                            onMouseLeave={() => setHoveredId(null)}
                        >
                            <button
                                type="button"
                                onClick={() => toggle(m)}
                                className="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                            >
                                {mode === 'multi' && (
                                    <span
                                        className="w-4 h-4 rounded border flex items-center justify-center flex-shrink-0"
                                        style={{
                                            background: selected ? 'var(--accent-primary)' : 'transparent',
                                            borderColor: selected ? 'var(--accent-primary)' : 'var(--border-default)',
                                        }}
                                    >
                                        {selected && <Check className="w-3 h-3 text-white" />}
                                    </span>
                                )}
                                {mode === 'single' && <FileAudio className="w-4 h-4 flex-shrink-0 text-[var(--text-muted)]" />}
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm truncate text-[var(--text-primary)]">{m.title || 'Untitled meeting'}</div>
                                    <div className="flex items-center gap-3 text-[11px] mt-0.5 text-[var(--text-muted)]">
                                        <span>{formatRelativeDate(m.createdAt)}</span>
                                        <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" />{formatDuration(m.durationSeconds)}</span>
                                        {m.speakerCount > 0 && (
                                            <span className="inline-flex items-center gap-1"><Users className="w-3 h-3" />{m.speakerCount}</span>
                                        )}
                                    </div>
                                </div>
                            </button>
                            {hoveredId === m.id && preview && preview.summary && (
                                <div
                                    className="absolute left-full top-0 ml-2 z-20 w-72 p-3 rounded-xl border shadow-lg text-[11px] leading-relaxed pointer-events-none hidden xl:block bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-secondary)]"
                                >
                                    <div className="font-semibold text-[12px] mb-1 text-[var(--text-primary)]">{preview.title}</div>
                                    <div className="line-clamp-6">{stripMd(preview.summary).slice(0, 220)}{preview.summary.length > 220 ? '…' : ''}</div>
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function stripMd(s: string) {
    return String(s || '').replace(/[#*_`>~\-]/g, '').replace(/\s+/g, ' ').trim();
}

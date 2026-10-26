import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Upload, Video, FileAudio, Search } from 'lucide-react';
import { useCapture } from '../../pages/meeting-notes/capture/CaptureContext';
import * as api from '../../api/transcriptionsApi';
import { formatRelativeDate } from '../../pages/meeting-notes/lib/format';
import Modal from '../shared/Modal';
import useTranslation from '../../hooks/useTranslation';
import type { LibraryMeeting } from '../../pages/meeting-notes/library/MeetingRow';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

declare global {
    interface Window {
        /** The id of the note MeetingNotesPage opens on its next mount (it clears it on read). */
        __beeflowPendingMeetingId?: string | null;
    }
}

interface PaletteUser {
    featureFlags?: { meeting_notes?: boolean };
    betaFeatures?: unknown[];
    isAdmin?: boolean;
    permissions?: string[] | null;
}

interface PaletteAction {
    id: string;
    label: string;
    icon: LucideIcon;
    accent: string;
    run: () => void;
}

type PaletteItem =
    | { kind: 'action'; payload: PaletteAction }
    | { kind: 'recent'; payload: LibraryMeeting };

interface MeetingCommandPaletteProps {
    user?: PaletteUser | null;
    onNavigate?: (page: string) => void;
}

/**
 * Scoped command palette opened with Ctrl/Cmd + Shift + M. Lists three quick
 * capture actions and the five most-recent meetings, so the user can jump back
 * to a meeting from anywhere without leaving the keyboard.
 */
export default function MeetingCommandPalette({ user, onNavigate }: MeetingCommandPaletteProps) {
    const { t } = useTranslation();
    const { openCapture } = useCapture();
    const flagsOn = user?.featureFlags?.meeting_notes !== false;
    const beta = Array.isArray(user?.betaFeatures) && user.betaFeatures.includes('meeting_notes');
    const adminLike = !!user?.isAdmin || (user?.permissions || []).includes('all');
    const allowed = flagsOn && (adminLike || beta);

    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [recent, setRecent] = useState<LibraryMeeting[]>([]);
    const [activeIdx, setActiveIdx] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    // Hotkey
    useEffect(() => {
        if (!allowed) return undefined;
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
                e.preventDefault();
                setOpen((o) => !o);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [allowed]);

    useAdjustOnChange([open], () => { if (open) { setQuery(''); setActiveIdx(0); } });
    useEffect(() => {
        if (!open) return;
        api.listTranscriptions().then((list) => setRecent(list.slice(0, 8))).catch(() => {});
        const timer = setTimeout(() => inputRef.current?.focus(), 30);
        return () => clearTimeout(timer);
    }, [open]);

    const actions = useMemo<PaletteAction[]>(() => ([
        { id: 'record', label: 'Start recording', icon: Mic, accent: '#ffd400', run: () => { openCapture('record'); setOpen(false); } },
        { id: 'upload', label: 'Upload audio file', icon: Upload, accent: 'var(--accent-primary)', run: () => { openCapture('upload'); setOpen(false); } },
        // Bee Flow has no meeting bot (removed): this opens the source picker,
        // where Talk, Google Meet and Teams recordings are imported.
        { id: 'import', label: 'Import a meeting recording', icon: Video, accent: '#10b981', run: () => { openCapture(null); setOpen(false); } },
    ]), [openCapture]);

    const filteredActions = useMemo(() => (
        !query ? actions : actions.filter((a) => a.label.toLowerCase().includes(query.toLowerCase()))
    ), [actions, query]);

    const filteredRecent = useMemo(() => (
        !query
            ? recent.slice(0, 5)
            : recent.filter((r) => (r.title || '').toLowerCase().includes(query.toLowerCase())).slice(0, 5)
    ), [recent, query]);

    const flat = useMemo<PaletteItem[]>(() => [
        ...filteredActions.map((a): PaletteItem => ({ kind: 'action', payload: a })),
        ...filteredRecent.map((r): PaletteItem => ({ kind: 'recent', payload: r })),
    ], [filteredActions, filteredRecent]);

    const runItem = (item: PaletteItem) => {
        if (item.kind === 'action') item.payload.run();
        else {
            window.__beeflowPendingMeetingId = item.payload.id;
            onNavigate?.('meetingNotes');
            setOpen(false);
        }
    };

    const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(flat.length - 1, i + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
        else if (e.key === 'Enter') {
            const item = flat[activeIdx];
            if (item) runItem(item);
        }
        // Escape is Modal's job now: the keydown on this input still bubbles
        // to its document-level listener, so handling it here too would fire
        // onClose twice.
    };

    if (!allowed || !open) return null;

    return (
        <Modal
            open
            onClose={() => setOpen(false)}
            placement="top"
            variant="bare"
            size="auto"
            label="Meeting actions"
            className="max-w-xl"
        >
            <div
                className="w-full rounded-2xl border shadow-2xl overflow-hidden bg-[var(--bg-secondary)] border-[var(--border-default)] text-[var(--text-primary)]"
            >
                <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-subtle)]">
                    <Search className="w-4 h-4 text-[var(--text-muted)]" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
                        onKeyDown={onKey}
                        placeholder={t('meetings.palette_placeholder', 'Search meeting actions or recent meetings…')}
                        className="flex-1 bg-transparent outline-none text-sm [color:var(--text-primary)]!"
                    />
                    <span className="text-[10px] px-1.5 py-0.5 rounded border text-[var(--text-muted)] border-[var(--border-default)]">
                        ESC
                    </span>
                </div>

                <div className="max-h-[50vh] overflow-auto">
                    {filteredActions.length > 0 && (
                        <Section label="Capture">
                            {filteredActions.map((a, i) => {
                                const idx = i;
                                const active = activeIdx === idx;
                                return (
                                    <Row key={a.id} active={active} onMouseEnter={() => setActiveIdx(idx)} onClick={() => runItem({ kind: 'action', payload: a })}>
                                        <a.icon className="w-4 h-4" style={{ color: a.accent }} />
                                        <span className="text-sm flex-1">{a.label}</span>
                                    </Row>
                                );
                            })}
                        </Section>
                    )}
                    {filteredRecent.length > 0 && (
                        <Section label="Recent meetings">
                            {filteredRecent.map((r, i) => {
                                const idx = filteredActions.length + i;
                                const active = activeIdx === idx;
                                return (
                                    <Row key={r.id} active={active} onMouseEnter={() => setActiveIdx(idx)} onClick={() => runItem({ kind: 'recent', payload: r })}>
                                        <FileAudio className="w-4 h-4 text-[var(--text-muted)]" />
                                        <span className="text-sm flex-1 truncate">{r.title || 'Untitled'}</span>
                                        <span className="text-[11px] text-[var(--text-muted)]">{formatRelativeDate(r.createdAt)}</span>
                                    </Row>
                                );
                            })}
                        </Section>
                    )}
                    {flat.length === 0 && (
                        <div className="px-4 py-8 text-sm text-center text-[var(--text-muted)]">
                            {t('meetings.palette_no_matches', 'No matches.')}
                        </div>
                    )}
                </div>
                <div className="px-4 py-2 border-t text-[11px] flex items-center justify-between border-[var(--border-subtle)] text-[var(--text-muted)]">
                    <span>{t('meetings.palette_hint', '↑↓ navigate · ↵ open')}</span>
                    <span>Ctrl/Cmd + Shift + M</span>
                </div>
            </div>
        </Modal>
    );
}

function Section({ label, children }: { label: string; children?: ReactNode }) {
    return (
        <div className="py-1.5">
            <div className="px-4 pt-1 pb-1 text-[10px] uppercase tracking-wide font-semibold text-[var(--text-muted)]">
                {label}
            </div>
            {children}
        </div>
    );
}

function Row({ active, onClick, onMouseEnter, children }: { active: boolean; onClick: () => void; onMouseEnter: () => void; children?: ReactNode }) {
    return (
        <button
            type="button"
            onClick={onClick}
            onMouseEnter={onMouseEnter}
            className="w-full flex items-center gap-3 px-4 py-2 text-left"
            style={{
                background: active ? 'var(--bg-tertiary)' : 'transparent',
                color: 'var(--text-primary)',
            }}
        >
            {children}
        </button>
    );
}

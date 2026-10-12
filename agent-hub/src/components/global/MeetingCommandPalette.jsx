import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Upload, Video, FileAudio, Search } from 'lucide-react';
import { useCapture } from '../../pages/meeting-notes/capture/CaptureContext';
import * as api from '../../pages/meeting-notes/lib/transcriptionsApi';
import { formatRelativeDate } from '../../pages/meeting-notes/lib/format';
import Modal from '../shared/Modal';
import useTranslation from '../../hooks/useTranslation';

/**
 * Scoped command palette opened with Ctrl/Cmd + Shift + M. Lists three quick
 * capture actions and the five most-recent meetings, so the user can jump back
 * to a meeting from anywhere without leaving the keyboard.
 */
export default function MeetingCommandPalette({ user, onNavigate }) {
    const { t } = useTranslation();
    const { openCapture } = useCapture();
    const flagsOn = user?.featureFlags?.meeting_notes !== false;
    const beta = Array.isArray(user?.betaFeatures) && user.betaFeatures.includes('meeting_notes');
    const adminLike = !!user?.isAdmin || (user?.permissions || []).includes('all');
    const allowed = flagsOn && (adminLike || beta);

    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [recent, setRecent] = useState([]);
    const [activeIdx, setActiveIdx] = useState(0);
    const inputRef = useRef(null);

    // Hotkey
    useEffect(() => {
        if (!allowed) return undefined;
        const onKey = (e) => {
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'M' || e.key === 'm')) {
                e.preventDefault();
                setOpen((o) => !o);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [allowed]);

    useEffect(() => {
        if (!open) return;
        setQuery('');
        setActiveIdx(0);
        api.listTranscriptions().then((list) => setRecent(list.slice(0, 8))).catch(() => {});
        const timer = setTimeout(() => inputRef.current?.focus(), 30);
        return () => clearTimeout(timer);
    }, [open]);

    const actions = useMemo(() => ([
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

    const flat = useMemo(() => [
        ...filteredActions.map((a) => ({ kind: 'action', payload: a })),
        ...filteredRecent.map((r) => ({ kind: 'recent', payload: r })),
    ], [filteredActions, filteredRecent]);

    const runItem = (item) => {
        if (item.kind === 'action') item.payload.run();
        else {
            window.__beeflowPendingMeetingId = item.payload.id;
            onNavigate?.('meetingNotes');
            setOpen(false);
        }
    };

    const onKey = (e) => {
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
                className="w-full rounded-2xl border shadow-2xl overflow-hidden"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
            >
                <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                    <Search className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
                        onKeyDown={onKey}
                        placeholder={t('meetings.palette_placeholder', 'Search meeting actions or recent meetings…')}
                        className="flex-1 bg-transparent outline-none text-sm"
                        style={{ color: 'var(--text-primary)' }}
                    />
                    <span className="text-[10px] px-1.5 py-0.5 rounded border" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-default)' }}>
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
                                        <FileAudio className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                                        <span className="text-sm flex-1 truncate">{r.title || 'Untitled'}</span>
                                        <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{formatRelativeDate(r.createdAt)}</span>
                                    </Row>
                                );
                            })}
                        </Section>
                    )}
                    {flat.length === 0 && (
                        <div className="px-4 py-8 text-sm text-center" style={{ color: 'var(--text-muted)' }}>
                            {t('meetings.palette_no_matches', 'No matches.')}
                        </div>
                    )}
                </div>
                <div className="px-4 py-2 border-t text-[11px] flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
                    <span>{t('meetings.palette_hint', '↑↓ navigate · ↵ open')}</span>
                    <span>Ctrl/Cmd + Shift + M</span>
                </div>
            </div>
        </Modal>
    );
}

function Section({ label, children }) {
    return (
        <div className="py-1.5">
            <div className="px-4 pt-1 pb-1 text-[10px] uppercase tracking-wide font-semibold" style={{ color: 'var(--text-muted)' }}>
                {label}
            </div>
            {children}
        </div>
    );
}

function Row({ active, onClick, onMouseEnter, children }) {
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

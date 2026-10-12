/**
 * The inline forms under the add-source tiles: a website URL, pasted text and
 * a meeting note. Each is a small card with its own title and a close button;
 * Enter submits the URL, Escape closes it.
 */
import React, { useState } from 'react';
import { Mic, X } from 'lucide-react';
import MeetingPickerJs from '../../../../components/meeting-picker/MeetingPicker';
import useTranslation from '../../../../hooks/useTranslation';
import { useCapture } from '../../../meeting-notes/capture/CaptureContext';

const MeetingPicker = MeetingPickerJs as unknown as React.ComponentType<any>;

/** Max characters for a pasted-text source (the server re-validates on ingest). */
export const PASTE_MAX_CHARS = 500000;

const CARD = 'shrink-0 mx-3 mb-2 rounded-xl border p-3 space-y-2 bg-[var(--bg-secondary)] border-[var(--border-default)]';
const FIELD = 'w-full px-2.5 py-1.5 rounded-lg text-xs border outline-none bg-[var(--bg-primary)] border-[var(--border-subtle)] text-[var(--text-primary)] focus:border-[var(--accent-primary)]';
const PRIMARY_BTN = 'shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-90 disabled:opacity-40';

function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">{title}</span>
            <button
                type="button"
                onClick={onClose}
                className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]"
                aria-label={t('notebooks.close_panel', 'Close')}
            >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
        </div>
    );
}

export function AddUrlPanel({ onSubmit, onClose }: { onSubmit: (url: string) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [value, setValue] = useState('');
    const submit = () => {
        const u = value.trim();
        if (!u) return;
        onSubmit(u);
        setValue('');
    };
    return (
        <div className={CARD}>
            <PanelHeader title={t('notebooks.add_url', 'Add URL')} onClose={onClose} />
            <div className="flex items-center gap-1.5">
                <input
                    autoFocus
                    type="url"
                    inputMode="url"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); submit(); }
                        if (e.key === 'Escape') onClose();
                    }}
                    placeholder={t('notebooks.url_placeholder', 'https://example.com/article')}
                    aria-label={t('notebooks.add_url', 'Add URL')}
                    className={`${FIELD} flex-1 min-w-0`}
                />
                <button type="button" onClick={submit} disabled={!value.trim()} className={PRIMARY_BTN}>{t('notebooks.add', 'Add')}</button>
            </div>
            <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                {t('notebooks.url_hint', 'The page text is fetched and indexed. Pages behind a login cannot be read.')}
            </p>
        </div>
    );
}

export function PasteTextPanel({ onSubmit, onClose }: { onSubmit: (text: string, name?: string) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const [text, setText] = useState('');
    const [name, setName] = useState('');
    const overLimit = text.length > PASTE_MAX_CHARS;
    const submit = () => {
        const body = text.trim();
        if (!body || overLimit) return;
        onSubmit(body, name.trim() || undefined);
        setText('');
        setName('');
    };
    return (
        <div className={CARD}>
            <PanelHeader title={t('notebooks.paste_text', 'Paste Text')} onClose={onClose} />
            <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('notebooks.name_optional', 'Name (optional)')}
                aria-label={t('notebooks.name_optional', 'Name (optional)')}
                className={FIELD}
            />
            <textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t('notebooks.paste_placeholder', 'Paste your text here…')}
                aria-label={t('notebooks.paste_text', 'Paste Text')}
                aria-invalid={overLimit || undefined}
                maxLength={PASTE_MAX_CHARS}
                className={`${FIELD} resize-none h-20 ${overLimit ? 'border-[var(--error)]' : ''}`}
            />
            {overLimit && (
                <p role="alert" className="m-0 text-[11px] font-medium text-[var(--error-ink)]">
                    {t('notebooks.paste_too_long', { max: PASTE_MAX_CHARS.toLocaleString() })}
                </p>
            )}
            <button type="button" onClick={submit} disabled={!text.trim() || overLimit} className={`${PRIMARY_BTN} w-full`}>
                {t('notebooks.add_text', 'Add Text')}
            </button>
        </div>
    );
}

export type MeetingMode = 'full' | 'summary';

export function MeetingSourcePanel({ mode, onChangeMode, onAddMeeting, onClose }: {
    mode: MeetingMode;
    onChangeMode: (m: MeetingMode) => void;
    onAddMeeting: (id: string) => void;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const { openCapture } = useCapture() as { openCapture: () => void };
    const options: { key: MeetingMode; label: string }[] = [
        { key: 'full', label: t('notebooks.full_transcript', 'Full transcript') },
        { key: 'summary', label: t('notebooks.summary_only', 'Summary only') },
    ];
    return (
        <div className={`${CARD} space-y-3`}>
            <PanelHeader title={t('notebooks.meeting_notes', 'Meeting Notes')} onClose={onClose} />
            <div>
                <p className="m-0 mb-1 text-[10px] uppercase font-bold tracking-wide text-[var(--text-tertiary)]" id="nb-meeting-mode">
                    {t('notebooks.include_as_source', 'Include as source')}
                </p>
                <div role="radiogroup" aria-labelledby="nb-meeting-mode" className="grid grid-cols-2 gap-0.5 p-0.5 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)]">
                    {options.map((opt) => {
                        const active = mode === opt.key;
                        return (
                            <button
                                key={opt.key}
                                type="button"
                                role="radio"
                                aria-checked={active}
                                onClick={() => onChangeMode(opt.key)}
                                className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-all ${
                                    active ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-sm' : 'text-[var(--text-secondary)]'
                                }`}
                            >
                                {opt.label}
                            </button>
                        );
                    })}
                </div>
            </div>
            <MeetingPicker
                mode="single"
                onSelect={(m: { id: string }) => onAddMeeting(m.id)}
                placeholder={t('notebooks.search_meeting_notes', 'Search meeting notes…')}
                emptyAction={(
                    <button
                        type="button"
                        onClick={() => openCapture()}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-semibold border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        <Mic className="w-3 h-3" aria-hidden="true" /> {t('notebooks.capture_one_now', 'Capture one now')}
                    </button>
                )}
            />
        </div>
    );
}

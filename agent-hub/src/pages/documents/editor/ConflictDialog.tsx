// "Compare and choose": what two people changed in the same part of a
// designed document, side by side, and a choice per part. Opened by the
// person from the save status or the notice, never on its own: a conflict
// waits calmly until they are ready for it.

import React, { useMemo, useState } from 'react';
import Modal from '../../../components/shared/Modal';
import useTranslation from '../../../hooks/useTranslation';
import type { Conflict } from '../useDocumentAutosave';

type Choice = 'mine' | 'theirs';

export interface ConflictDialogProps {
    open: boolean;
    conflict: Conflict;
    busy?: boolean;
    onSave: (choices: Record<string, Choice>) => void;
    onDiscardMine: () => void;
    onClose: () => void;
}

/** The text of a piece of HTML, parsed without running anything. */
export function textOf(html: string): string {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
}

function Side({ title, text, chosen, onChoose, name }: { title: string; text: string; chosen: boolean; onChoose: () => void; name: string }) {
    const { t } = useTranslation();
    return (
        <label className={`flex-1 min-w-0 rounded-lg border p-2.5 cursor-pointer ${chosen ? 'border-[var(--accent-primary)] bg-[var(--bg-tertiary)]' : 'border-[var(--border-subtle)]'}`}>
            <span className="flex items-center gap-2 text-[12px] font-semibold text-[var(--text-primary)]">
                <input type="radio" name={name} checked={chosen} onChange={onChoose} />{title}
            </span>
            <span className="block mt-1.5 text-[12px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-48 overflow-auto">
                {text || <em className="text-[var(--text-tertiary)]">{t('documents.conflict.removed', 'Removed')}</em>}
            </span>
        </label>
    );
}

function Footer({ count, busy, onAll, onSave, onDiscardMine }: { count: number; busy: boolean; onAll: (c: Choice) => void; onSave: () => void; onDiscardMine: () => void }) {
    const { t } = useTranslation();
    const secondary = 'h-8 px-3 rounded-lg text-[13px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50';
    return (
        <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="mr-auto text-[12px] underline text-[var(--text-tertiary)]" onClick={onDiscardMine} disabled={busy}>
                {t('documents.conflict.discard_mine', 'Discard my changes')}
            </button>
            {count > 1 && <button type="button" className={secondary} onClick={() => onAll('mine')} disabled={busy}>{t('documents.conflict.all_mine', 'Keep all mine')}</button>}
            {count > 1 && <button type="button" className={secondary} onClick={() => onAll('theirs')} disabled={busy}>{t('documents.conflict.all_theirs', 'Take all theirs')}</button>}
            <button type="button" className="h-8 px-3 rounded-lg text-xs font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-50" onClick={onSave} disabled={busy} data-testid="conflict-save">
                {busy ? t('documents.save.saving', 'Saving…') : t('documents.conflict.save', 'Save my choices')}
            </button>
        </div>
    );
}

export default function ConflictDialog({ open, conflict, busy = false, onSave, onDiscardMine, onClose }: ConflictDialogProps) {
    const { t } = useTranslation();
    const parts = useMemo(() => conflict.parts.filter((p): p is Extract<typeof p, { kind: 'conflict' }> => p.kind === 'conflict'), [conflict]);
    const [choices, setChoices] = useState<Record<string, Choice>>({});
    const choose = (key: string, c: Choice) => setChoices((prev) => ({ ...prev, [key]: c }));
    const all = (c: Choice) => setChoices(Object.fromEntries(parts.map((p) => [p.key, c])));
    return (
        <Modal open={open} onClose={onClose} title={t('documents.conflict.title', 'Compare and choose')} size="lg" disableEscapeClose={busy}
            footer={<Footer count={parts.length} busy={busy} onAll={all} onSave={() => onSave(choices)} onDiscardMine={onDiscardMine} />}>
            <p className="text-[13px] text-[var(--text-secondary)] mb-3">
                {t('documents.conflict.intro', 'Someone else saved changes to the same part while you were editing. Everything else was combined. For each part, choose which text to keep.')}
            </p>
            <ol className="space-y-4" data-testid="conflict-parts">
                {parts.map((p) => (
                    <li key={p.key}>
                        <p className="text-[12px] font-semibold text-[var(--text-primary)] mb-1.5">{p.label || t('documents.conflict.untitled_part', 'A part of the document')}</p>
                        <div className="flex flex-col sm:flex-row gap-2">
                            <Side name={`conflict-${p.key}`} title={t('documents.conflict.yours', 'Your version')} text={textOf(p.mine)} chosen={(choices[p.key] || 'mine') === 'mine'} onChoose={() => choose(p.key, 'mine')} />
                            <Side name={`conflict-${p.key}`} title={t('documents.conflict.theirs', 'Saved meanwhile')} text={textOf(p.theirs)} chosen={choices[p.key] === 'theirs'} onChoose={() => choose(p.key, 'theirs')} />
                        </div>
                    </li>
                ))}
            </ol>
        </Modal>
    );
}

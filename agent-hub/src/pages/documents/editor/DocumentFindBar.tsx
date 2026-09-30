// Find in a designed document: the frame highlights every match and scrolls
// to the current one; Enter / Shift+Enter step, Escape closes.

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { ICON_BUTTON } from './ui';

export interface DocumentFindBarProps {
    result: { count: number; index: number } | null;
    focusSignal: number;
    onFind: (query: string, step: number) => void;
    onClose: () => void;
}

export default function DocumentFindBar({ result, focusSignal, onFind, onClose }: DocumentFindBarProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const input = useRef<HTMLInputElement | null>(null);
    useEffect(() => { input.current?.focus(); input.current?.select(); }, [focusSignal]);
    useEffect(() => {
        const timer = setTimeout(() => onFind(query, 0), 200);
        return () => clearTimeout(timer);
    }, [query, onFind]);
    const close = () => { onFind('', 0); onClose(); };
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); onFind(query, e.shiftKey ? -1 : 1); }
        if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    const count = result?.count ?? 0;
    return (
        <div role="search" className="flex items-center gap-2 px-4 py-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)]" data-testid="document-find">
            <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
                aria-label={t('documents.find.label', 'Find in document')} placeholder={t('documents.find.placeholder', 'Find in document…')}
                className="w-64 max-w-full px-2 py-1 rounded-md text-[13px] border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]" />
            <span className="text-[11px] tabular-nums text-[var(--text-tertiary)]" aria-live="polite" data-testid="document-find-count">
                {query ? (count ? t('documents.find.count', '{index} of {count}', { index: (result?.index ?? 0) + 1, count }) : t('documents.find.none', 'No matches')) : ''}
            </span>
            <button type="button" className={ICON_BUTTON} disabled={!count} onClick={() => onFind(query, -1)} aria-label={t('documents.find.previous', 'Previous match')}><ChevronUp size={14} /></button>
            <button type="button" className={ICON_BUTTON} disabled={!count} onClick={() => onFind(query, 1)} aria-label={t('documents.find.next', 'Next match')}><ChevronDown size={14} /></button>
            <button type="button" className={ICON_BUTTON} onClick={close} aria-label={t('documents.find.close', 'Close find')}><X size={14} /></button>
        </div>
    );
}

import React, { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Search, X } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import { messageOf } from '../../../utils/caughtError';
import { INPUT_CLASS, inputStyle } from '../../admin/Studio/AppStudio/runtime/uiBits';
import type { AppPick, AppPickFieldProps, AppPickRow } from '../PublicFormRenderer.types';

/**
 * "Pick from an app": search the app the question names, choose a record.
 *
 * What travels with the submission is a REFERENCE — `{ kind:'app_pick',
 * recordId, title }` — never the record itself. The server re-reads the record
 * as the person submitting, at submit time, which is what keeps this from being
 * a way to post someone else's transcript into an automation by hand-crafting a
 * body.
 *
 * The search runs against the FILLER's own account. So "no results" here can
 * mean "you have not connected this app", and the server says which — printed
 * next to the box rather than thrown, because it is not the person's mistake.
 */
export default function AppPickField({ field, value, disabled, onChange, onSearch }: AppPickFieldProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<AppPickRow[]>([]);
    const [searching, setSearching] = useState(false);
    const [note, setNote] = useState('');
    const [opened, setOpened] = useState(false);

    const picked = useMemo<AppPick[]>(
        () => (Array.isArray(value) ? value : (value ? [value] : [])),
        [value],
    );
    const full = field.multiple ? picked.length >= (field.maxItems || 5) : picked.length >= 1;

    // Debounced, and only while the picker is open. The search hits the app the
    // question names on every pause in typing, so a keystroke-per-request would
    // be both slow and rude to the upstream API.
    useEffect(() => {
        if (!opened || !onSearch) return undefined;
        let live = true;
        setSearching(true);
        const timer = setTimeout(async () => {
            try {
                const out = await onSearch(field, query);
                if (!live) return;
                setResults(Array.isArray(out?.results) ? out.results : []);
                setNote(out?.error || '');
            } catch (err) {
                if (!live) return;
                setResults([]);
                setNote(messageOf(err, 'That app could not be searched.'));
            } finally {
                if (live) setSearching(false);
            }
        }, 300);
        return () => { live = false; clearTimeout(timer); };
    }, [opened, query, onSearch, field]);

    const add = (row: AppPickRow) => {
        const pick: AppPick = { kind: 'app_pick', source: field.source, recordId: row.id, title: row.title };
        if (field.multiple) {
            if (picked.some(p => p.recordId === row.id)) return;
            onChange([...picked, pick]);
        } else {
            onChange(pick);
            setOpened(false);
        }
        setQuery('');
    };

    const remove = (recordId: string) => {
        if (field.multiple) onChange(picked.filter(p => p.recordId !== recordId));
        else onChange(null);
    };

    return (
        <div className="flex flex-col gap-2" data-testid={`form-apppick-${field.name}`}>
            {picked.map(p => (
                <div
                    key={p.recordId}
                    className="flex items-center gap-2 px-3 py-2 border text-sm"
                    style={{
                        borderColor: 'var(--border-default)',
                        borderRadius: 'var(--app-radius)',
                        background: 'var(--bg-card, var(--bg-secondary))',
                        color: 'var(--text-primary)',
                    }}
                >
                    <Check size={14} aria-hidden="true" style={{ color: 'var(--app-primary)', flexShrink: 0 }} />
                    <span className="min-w-0 flex-1 truncate">{p.title || p.recordId}</span>
                    <button
                        type="button"
                        disabled={disabled}
                        onClick={() => remove(p.recordId)}
                        aria-label={`Remove ${p.title || p.recordId}`}
                        style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}
                    >
                        <X size={14} />
                    </button>
                </div>
            ))}

            {!full && (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setOpened(v => !v)}
                    className="flex items-center gap-2 px-3 py-2 border text-sm"
                    style={{
                        borderColor: 'var(--border-default)',
                        borderRadius: 'var(--app-radius)',
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                    }}
                >
                    <Search size={14} aria-hidden="true" />
                    <span>{picked.length ? `Add another from ${field.app || 'the app'}` : `Choose from ${field.app || 'an app'}`}</span>
                </button>
            )}

            {opened && !full && (
                <div
                    className="flex flex-col gap-1 p-2 border"
                    style={{ borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', background: 'var(--bg-card, var(--bg-secondary))' }}
                >
                    <input
                        type="text"
                        autoFocus
                        disabled={disabled}
                        value={query}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                        placeholder={field.searchHint || `Search ${field.app || ''}`.trim()}
                        className={INPUT_CLASS}
                        style={inputStyle(false)}
                        aria-label={`Search ${field.app || 'the app'}`}
                    />
                    {searching && (
                        <span className="flex items-center gap-1.5 px-1 py-1 text-xs text-[var(--text-muted)]">
                            <Loader2 size={12} className="animate-spin" /> {t('forms.searching', 'Searching…')}
                        </span>
                    )}
                    {!searching && note && (
                        <p className="px-1 py-1 text-xs" style={{ color: 'var(--text-muted)' }}>{note}</p>
                    )}
                    {!searching && !note && results.length === 0 && (
                        <p className="px-1 py-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                            {onSearch ? 'Nothing found.' : 'The search runs on the live form.'}
                        </p>
                    )}
                    {results.map(row => (
                        <button
                            key={row.id}
                            type="button"
                            disabled={disabled || picked.some(p => p.recordId === row.id)}
                            onClick={() => add(row)}
                            className="flex flex-col items-start gap-0.5 px-2 py-1.5 text-left text-sm"
                            style={{ borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' }}
                        >
                            <span className="w-full truncate font-medium">{row.title}</span>
                            {row.subtitle ? (
                                <span className="w-full truncate text-xs text-[var(--text-muted)]">{row.subtitle}</span>
                            ) : null}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

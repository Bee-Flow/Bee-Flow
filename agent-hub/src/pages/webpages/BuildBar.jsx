import { Loader2, Sparkles, Table, Workflow, X } from 'lucide-react';
import React from 'react';
import SourcePicker from './SourcePicker';
import { kindColorVar, kindTint } from '../../components/shared/kindColors';
import { PRIMARY_ACTION_STYLE } from '../../components/shared/StudioSectionHeader';
import useTranslation from '../../hooks/useTranslation';

/**
 * The describe-to-build bar above the cards (Webpages artboard 1a, plan W1).
 *
 * The old overview asked for a NAME. A name is the one thing the AI could have
 * worked out for itself, and it told the builder nothing — every new page
 * opened on an empty chat with the user having to start over in prose. This
 * bar asks for the brief instead, plus the sources the page should read, and
 * hands both to `POST /api/webpages { name?, prompt, sources }`, which creates
 * the page and opens the editor with the chat already seeded.
 *
 * The name-only shortcut is not gone — it moved under "All options" in the
 * overview, where a shortcut belongs.
 *
 * Props
 *   prompt / onPromptChange   the brief (the caller owns it: the example card
 *                             writes into the same box)
 *   sources / onSourcesChange [{ kind: 'datatable' | 'automation', id, name }]
 *   onBuild()                 build with the current prompt + sources
 *   building                  request in flight
 *   inputRef                  so a preset click can focus the box it filled
 */
export default function BuildBar({
    prompt,
    onPromptChange,
    sources = [],
    onSourcesChange,
    onBuild,
    building = false,
    inputRef = null,
}) {
    const { t } = useTranslation();
    const canBuild = !!onBuild && !!prompt.trim() && !building;

    const submit = (e) => {
        e.preventDefault();
        if (!canBuild) return;
        onBuild();
    };

    return (
        <form
            onSubmit={submit}
            data-testid="webpages-build-bar"
            className="flex flex-col gap-2"
            style={{
                padding: '14px 16px',
                borderRadius: 12,
                border: '1px solid var(--border-default)',
                background: 'var(--bg-card)',
                boxShadow: 'var(--shadow-sm)',
            }}
        >
            <div className="flex items-center gap-3">
                <div
                    aria-hidden="true"
                    className="grid place-items-center shrink-0"
                    style={{
                        width: 36, height: 36, borderRadius: 10,
                        background: kindTint('agent', 14),
                        color: kindColorVar('agent'),
                    }}
                >
                    <Sparkles size={17} />
                </div>
                <input
                    ref={inputRef}
                    type="text"
                    value={prompt}
                    onChange={(e) => onPromptChange(e.target.value)}
                    disabled={building}
                    aria-label={t('webpages.build.aria', 'Describe the page you want')}
                    placeholder={t(
                        'webpages.build.placeholder',
                        'Describe the page — e.g. "a status page where customers enter their quote number and see the progress from table Quotes"',
                    )}
                    className="flex-1 min-w-0 text-[13px] outline-none focus:ring-2 focus:ring-[var(--accent-primary)] disabled:opacity-60"
                    style={{
                        padding: '9px 12px',
                        borderRadius: 8,
                        border: '1px solid var(--border-default)',
                        background: 'transparent',
                        color: 'var(--text-primary)',
                    }}
                />
                <SourcePicker value={sources} onChange={onSourcesChange} disabled={building} />
                <button
                    type="submit"
                    disabled={!canBuild}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-semibold disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                    style={{ ...PRIMARY_ACTION_STYLE, height: 34, padding: '0 14px', borderRadius: 10 }}
                >
                    {building && <Loader2 size={13} className="animate-spin" aria-hidden="true" />}
                    {building ? t('webpages.build.building', 'Building…') : t('webpages.build.build', 'Build')}
                </button>
            </div>

            {/* What was picked, said out loud. The artboard draws the chooser
                but never what came out of it, and a source you cannot see is a
                source you cannot take back. */}
            {sources.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pl-[48px]" data-testid="webpages-build-sources">
                    {sources.map(s => (
                        <SourceChip
                            key={`${s.kind}:${s.id}`}
                            source={s}
                            onRemove={() => onSourcesChange?.(sources.filter(x => !(x.kind === s.kind && x.id === s.id)))}
                            t={t}
                        />
                    ))}
                </div>
            )}
        </form>
    );
}

function SourceChip({ source, onRemove, t }) {
    const Icon = source.kind === 'automation' ? Workflow : Table;
    return (
        <span
            className="inline-flex items-center gap-1 text-[11px] font-semibold"
            style={{
                padding: '1px 7px',
                borderRadius: 999,
                background: kindTint(source.kind, 14),
                color: kindColorVar(source.kind),
            }}
        >
            <Icon size={10} aria-hidden="true" />
            {source.name || source.id}
            <button
                type="button"
                onClick={onRemove}
                aria-label={t('webpages.build.remove_source', 'Remove {name}', { name: source.name || source.id })}
                className="ml-0.5 opacity-70 hover:opacity-100"
            >
                <X size={10} aria-hidden="true" />
            </button>
        </span>
    );
}

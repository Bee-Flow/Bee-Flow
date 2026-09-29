import { AlertCircle, ChevronDown, LayoutTemplate, Loader2, Plus, Search, X } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import BuildBar from './BuildBar';
import promptPresets from './promptPresets';
import WebpageCard from './WebpageCard';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../components/shared/StudioSectionHeader';
import useTranslation from '../../hooks/useTranslation';

/**
 * WebpagesList — the Webpages overview (artboard 1a, plan W1).
 *
 * Three things changed against the W0 split, and they are the whole track:
 *
 *   1. It opens with `StudioSectionHeader`, the row every Studio object now
 *      shares, so "where is search / where is New" is learned once.
 *   2. Making a page starts from a BRIEF, not a name (`BuildBar`). The
 *      name-only shortcut still exists, under "All options", because a
 *      shortcut is not the front door.
 *   3. A card says what the page IS: its own rendered preview, who can see it
 *      (including the derived "Public" state a public share creates), and the
 *      tables and automations it is wired to.
 *
 * Still purely presentational: every request leaves through a callback the
 * shell passes in, and the only local state is the search box, the build
 * bar's draft, the "All options" disclosure and the in-card rename editor.
 *
 * Props
 *   webpages          list rows (id, name, tagline, icon, thumbnailSha,
 *                     updatedAt, isPublished, sharedGroups, bridgeGrants,
 *                     publicShareCount, …)
 *   loading           list fetch in flight
 *   loadingWebpageId  card whose open is in flight (spinner + dims the rest)
 *   error / onDismissError
 *   newName / onNewNameChange / creating / onCreate(e)   the name-only shortcut
 *   onBuild({ prompt, sources })   describe-to-build; resolves when the page
 *                     has been created (the shell opens the editor)
 *   building          a build request is in flight
 *   onOpen(id) / onEdit(id) / onClone(id) / onDelete(id) / onRename(id, name)
 *   onBack            optional back arrow
 *
 * `embedded` is gone: the section header IS the header now, in the Studio
 * mount and standalone alike (Studio Home artboard 1b). The shell may keep
 * passing it; it is ignored.
 */
export default function WebpagesList({
    webpages = [],
    loading = false,
    loadingWebpageId,
    error,
    onDismissError,
    newName,
    onNewNameChange,
    creating,
    onCreate,
    onBuild,
    building = false,
    onOpen,
    onEdit,
    onClone,
    onDelete,
    onRename,
    onBack,
}) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const [prompt, setPrompt] = useState('');
    const [sources, setSources] = useState([]);
    const [showAllOptions, setShowAllOptions] = useState(false);
    const [renamingId, setRenamingId] = useState(null);
    const [renameValue, setRenameValue] = useState('');
    const promptRef = useRef(null);

    const filtered = useMemo(() => {
        if (!search.trim()) return webpages;
        const q = search.toLowerCase();
        return webpages.filter(w => (w.name || '').toLowerCase().includes(q)
            || (w.tagline || '').toLowerCase().includes(q));
    }, [webpages, search]);

    // Enter and the blur it causes both try to commit — the ref makes the
    // second call a no-op so one rename is one PUT.
    const renamingRef = useRef(null);
    const startRename = (w) => {
        renamingRef.current = w.id;
        setRenamingId(w.id);
        setRenameValue(w.name);
    };
    const cancelRename = () => {
        renamingRef.current = null;
        setRenamingId(null);
        setRenameValue('');
    };
    const commitRename = (id) => {
        if (renamingRef.current !== id) return;
        const trimmed = renameValue.trim();
        cancelRename();
        if (!trimmed) return;
        onRename?.(id, trimmed);
    };

    const focusPrompt = () => {
        // A shell that has not wired `onBuild` yet cannot build from a brief;
        // "New webpage" then opens the shortcut rather than a dead text box.
        if (!onBuild) { setShowAllOptions(true); return; }
        promptRef.current?.focus();
        promptRef.current?.scrollIntoView({ block: 'nearest' });
    };

    const build = async () => {
        // Only clear once the page exists — a failed build must not throw the
        // brief away, it is the only copy of what the user asked for. `onBuild`
        // therefore REJECTS on failure (the shell paints the banner).
        try {
            await onBuild?.({ prompt: prompt.trim(), sources });
        } catch {
            return;
        }
        setPrompt('');
        setSources([]);
    };

    const usePreset = (preset) => {
        setPrompt(preset.prompt);
        focusPrompt();
    };

    return (
        <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
            <StudioSectionHeader
                kind="webpage"
                title={t('webpages.title', 'Webpages')}
                // A plain count, not the bordered chip: the artboard sets a
                // number beside the name, and a ready element keeps that slot's
                // testid so the header reads the same in every section.
                statusChip={!loading && webpages.length > 0 ? (
                    <span
                        data-testid="studio-section-status"
                        className="text-xs tabular-nums shrink-0"
                        style={{ color: 'var(--text-tertiary)' }}
                    >
                        {webpages.length}
                    </span>
                ) : null}
                onBack={onBack}
                backLabel={t('webpages.back', 'Back to Studio')}
                // The slot left of the primary. An overview has no audience of
                // its own, so the artboard's 220px search field takes it.
                capsule={<SearchField t={t} value={search} onChange={setSearch} />}
                primary={(
                    <button
                        type="button"
                        onClick={focusPrompt}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('webpages.new', 'New webpage')}
                    </button>
                )}
            />

            {error && (
                <div
                    className="shrink-0 px-4 py-2 text-xs flex items-center gap-2"
                    style={{ background: 'color-mix(in srgb, var(--error) 12%, transparent)', color: 'var(--error-ink)' }}
                    role="alert"
                >
                    <AlertCircle className="w-3.5 h-3.5" aria-hidden="true" /> {error}
                    <button onClick={onDismissError} className="ml-auto" aria-label={t('webpages.dismiss_error', 'Dismiss error')}>
                        <X className="w-3 h-3" aria-hidden="true" />
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto custom-scrollbar" style={{ padding: '24px 28px' }}>
                <div className="flex flex-col" style={{ gap: 18 }}>
                    <div className="flex flex-col gap-2">
                        <BuildBar
                            prompt={prompt}
                            onPromptChange={setPrompt}
                            sources={sources}
                            onSourcesChange={setSources}
                            onBuild={onBuild ? build : undefined}
                            building={building}
                            inputRef={promptRef}
                        />
                        <AllOptions
                            t={t}
                            open={showAllOptions}
                            onToggle={() => setShowAllOptions(o => !o)}
                            newName={newName}
                            onNewNameChange={onNewNameChange}
                            creating={creating}
                            onCreate={onCreate}
                        />
                    </div>

                    {loading ? (
                        <div className="flex items-center justify-center py-16">
                            <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent-primary)' }} aria-hidden="true" />
                        </div>
                    ) : search.trim() && filtered.length === 0 ? (
                        <EmptySearch t={t} />
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" style={{ gap: 14 }}>
                            {filtered.map(w => (
                                <WebpageCard
                                    key={w.id}
                                    webpage={w}
                                    t={t}
                                    dimmed={!!loadingWebpageId}
                                    opening={loadingWebpageId === w.id}
                                    renaming={renamingId === w.id}
                                    renameValue={renameValue}
                                    onRenameValueChange={setRenameValue}
                                    onStartRename={startRename}
                                    onCommitRename={commitRename}
                                    onCancelRename={cancelRename}
                                    onOpen={onOpen}
                                    onEdit={onEdit}
                                    onClone={onClone}
                                    onDelete={onDelete}
                                />
                            ))}
                            <ExampleCard t={t} onPick={usePreset} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

/** The header's 220px search field (artboard 1a). */
function SearchField({ t, value, onChange }) {
    const label = t('webpages.search', 'Search…');
    return (
        <div
            className="flex items-center gap-2 text-xs"
            style={{
                width: 220, padding: '6px 10px', borderRadius: 8,
                border: '1px solid var(--border-default)', background: 'var(--bg-card)',
            }}
        >
            <Search className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            <input
                type="search"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={label}
                aria-label={label}
                className="min-w-0 flex-1 bg-transparent outline-none"
                style={{ color: 'var(--text-primary)' }}
            />
        </div>
    );
}

/**
 * The name-only shortcut, kept but demoted (plan W1). The panel stays MOUNTED
 * while collapsed — `hidden` takes it out of the layout and the accessibility
 * tree, which is what a disclosure means, and keeps the form addressable for
 * anything holding a reference to it.
 */
function AllOptions({ t, open, onToggle, newName, onNewNameChange, creating, onCreate }) {
    return (
        <div>
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="inline-flex items-center gap-1 text-[11px] transition-colors hover:text-[var(--text-primary)]"
                style={{ color: 'var(--text-tertiary)' }}
            >
                <ChevronDown size={12} aria-hidden="true" className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
                {t('webpages.all_options', 'All options')}
            </button>
            <div hidden={!open}>
                <form onSubmit={onCreate} className="flex items-center gap-2 pt-2">
                    <input
                        type="text"
                        placeholder={t('webpages.new_name_placeholder', 'New webpage name…')}
                        value={newName}
                        onChange={(e) => onNewNameChange(e.target.value)}
                        disabled={creating}
                        className="flex-1 min-w-0 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                        style={{ borderRadius: 8, border: '1px solid var(--border-default)', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
                    />
                    <button
                        type="submit"
                        disabled={creating || !newName.trim()}
                        className="inline-flex items-center gap-1 px-3 py-2 text-sm font-medium disabled:opacity-50"
                        style={{ ...PRIMARY_ACTION_STYLE, borderRadius: 8 }}
                    >
                        {creating
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                            : <Plus className="w-3.5 h-3.5" aria-hidden="true" />}
                        {t('webpages.create', 'Create')}
                    </button>
                </form>
                <p className="pt-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {t('webpages.name_only_hint', 'Creates an empty page you can describe later in its chat.')}
                </p>
            </div>
        </div>
    );
}

/**
 * The dashed last cell (artboard 1a). Its four phrases are the artboard's
 * own, one middot-separated line — but each is a button that fills the build
 * bar, because there is no template entity behind them (plan deviation).
 */
function ExampleCard({ t, onPick }) {
    const presets = promptPresets(t);
    return (
        <div
            data-testid="webpages-examples"
            className="flex flex-col items-center justify-center text-center"
            style={{
                borderRadius: 12,
                border: '1px dashed var(--border-default)',
                gap: 8, padding: 24, color: 'var(--text-secondary)',
            }}
        >
            <LayoutTemplate size={22} aria-hidden="true" style={{ color: 'var(--text-tertiary)' }} />
            <div className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('webpages.examples.title', 'Start from an example')}
            </div>
            <div className="text-[12px] leading-[17px]">
                {presets.map((preset, i) => (
                    <React.Fragment key={preset.id}>
                        {i > 0 && <span aria-hidden="true"> · </span>}
                        <button
                            type="button"
                            onClick={() => onPick(preset)}
                            className="underline-offset-2 hover:underline hover:text-[var(--text-primary)]"
                        >
                            {preset.label}
                        </button>
                    </React.Fragment>
                ))}
            </div>
        </div>
    );
}

function EmptySearch({ t }) {
    return (
        <div className="flex flex-col items-center justify-center text-center py-20">
            <Search className="w-10 h-10 mb-3" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            <h3 className="text-base font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                {t('webpages.empty.no_matches', 'No matches')}
            </h3>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                {t('webpages.empty.try_another', 'Try a different search.')}
            </p>
        </div>
    );
}

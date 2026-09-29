import { useDroppable } from '@dnd-kit/core';
import { Home, MoreHorizontal, PanelsTopLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { screenTabDroppableId } from './dnd';
import NavGroupsDialog from './NavGroupsDialog';
import AppIcon from '../../../../icons/AppIcon';
import AnchoredMenu from '../../../../shared/AnchoredMenu';
import ConfirmDialog from '../../../../shared/ConfirmDialog';
import { useAppEditor } from '../state/AppEditorContext';
import { addScreen, removeScreen, updateScreen } from '../state/definitionOps';
import useTranslation from '../../../../../hooks/useTranslation';

/**
 * A screen pill wrapped as a drop target: dragging a canvas node (or a palette
 * component) onto it moves/inserts into that screen's first section (see
 * dnd.js computeDragEnd). The accent tint on hover reads as "drop here".
 */
function DroppableTab({ screenId, active, recent = false, onRevealed, children }) {
    const { setNodeRef, isOver } = useDroppable({
        id: screenTabDroppableId(screenId),
        data: { type: 'screentab', screenId },
    });
    return (
        <div
            ref={setNodeRef}
            data-screentab-over={isOver || undefined}
            data-screentab-active={active || undefined}
            // A screen the AI just added rings its pill — the chapter break of
            // the build film. Same class/clear cycle as a component cell.
            data-just-added={recent || undefined}
            className={`group relative flex shrink-0 items-center rounded-md transition-colors ${recent ? 'ase-added-pulse' : ''}`}
            onAnimationEnd={recent ? onRevealed : undefined}
            style={{
                ...(active ? { background: 'var(--bg-card)', boxShadow: 'var(--shadow-sm)' } : undefined),
                ...(isOver ? { background: 'color-mix(in srgb, var(--editor-accent) 14%, transparent)' } : undefined),
            }}
        >
            {children}
        </div>
    );
}

/**
 * App Studio editor — the screen tabs as ONE PILL GROUP (Studio artboard 1b,
 * row 2: `bg-tertiary` r8 p2 · pills `padding 4px 10px` r6, the active one
 * `bg-card` + shadow-sm, 12px icons, the "+" as the last pill).
 *
 * One pill per screen (icon + name, a little Home badge on the home screen),
 * a + pill appending a screen, and a per-tab kebab menu: inline rename,
 * set-as-home, manage navigation, delete (disabled on the last screen —
 * removeScreen refuses it anyway). All edits build the next definition via
 * definitionOps and go through onCommit.
 *
 * Every pill is still a DROP TARGET (`useDroppable(screenTabDroppableId)` +
 * `data-screentab-over`, which dnd.js reads): dragging a canvas node or a
 * palette card onto a tab moves/inserts it into that screen's first section.
 *
 * `inline` renders the bare pill group for a host row (EditorToolRow); the
 * default keeps a full-width strip with its own bottom border, so the
 * component still stands on its own.
 */

export default function ScreenTabs({ onCommit, inline = false }) {
    const { t } = useTranslation();
    const { definition, screenId, streamLock, recentlyAddedIds, dispatch } = useAppEditor();
    const screens = definition?.screens || [];

    const [menuFor, setMenuFor] = useState(null);
    const [renamingId, setRenamingId] = useState(null);
    const [renameValue, setRenameValue] = useState('');
    const [confirmDeleteId, setConfirmDeleteId] = useState(null);
    const [managingNav, setManagingNav] = useState(false);
    const renameInputRef = useRef(null);
    // The open menu's anchor — set from the kebab's own click event, so no
    // ref map has to be read during render.
    const menuAnchorRef = useRef(null);
    // Tab buttons, so a screen switch can scroll its tab into view.
    const tabRefs = useRef({});

    useEffect(() => {
        if (renamingId) renameInputRef.current?.select();
    }, [renamingId]);

    // Whatever switches the screen — a tab click, ⌘K, a save notice's
    // "Show me", an AI turn — the strip must show WHICH tab is active, not
    // leave it scrolled out of sight past the strip's edge.
    useEffect(() => {
        const el = tabRefs.current[screenId];
        if (el && typeof el.scrollIntoView === 'function') {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }, [screenId]);

    const handleAdd = () => {
        const { def, screenId: newScreenId } = addScreen(definition, {
            name: t('app_studio.screens.default_name', 'Screen {n}', { n: screens.length + 1 }),
        });
        onCommit?.(def);
        dispatch({ type: 'set_screen', screenId: newScreenId });
    };

    const startRename = (screen) => {
        setMenuFor(null);
        setRenamingId(screen.id);
        setRenameValue(screen.name || '');
    };

    const commitRename = () => {
        const id = renamingId;
        setRenamingId(null);
        if (!id) return;
        const name = renameValue.trim();
        if (!name) return;
        const next = updateScreen(definition, id, { name });
        if (next !== definition) onCommit?.(next);
    };

    const handleSetHome = (id) => {
        setMenuFor(null);
        if (definition.homeScreenId === id) return;
        onCommit?.({ ...definition, homeScreenId: id });
    };

    const handleDelete = () => {
        const id = confirmDeleteId;
        setConfirmDeleteId(null);
        if (!id) return;
        const next = removeScreen(definition, id);
        if (next !== definition) onCommit?.(next);
    };

    const deletingScreen = screens.find((s) => s.id === confirmDeleteId) || null;
    const menuScreen = menuFor ? screens.find((s) => s.id === menuFor) || null : null;
    const untitled = t('app_studio.screens.untitled', 'Screen');

    const strip = (
        /*
         * The pills scroll in their own row; the "+" stays pinned as the LAST
         * pill so adding a screen never requires scrolling first. The kebab
         * menu is an AnchoredMenu — a portal to <body> — because a menu
         * positioned inside a scroll container gets clipped by it
         * (`overflow-y: visible` next to `overflow-x: auto` computes to
         * `auto`, so the old top-full menu was cut off at the strip's edge no
         * matter where the overflow lived).
         */
        <div
            className="flex min-w-0 items-center gap-[2px] rounded-lg p-[2px] text-xs font-medium"
            style={{ background: 'var(--bg-tertiary)' }}
            data-testid="screen-tabs"
        >
            <div className="flex min-w-0 items-center gap-[2px] overflow-x-auto">
                {screens.map((screen) => {
                    const active = screen.id === screenId;
                    const isHome = definition?.homeScreenId === screen.id;
                    return (
                        <DroppableTab
                            key={screen.id}
                            screenId={screen.id}
                            active={active}
                            recent={recentlyAddedIds instanceof Set && recentlyAddedIds.has(screen.id)}
                            onRevealed={() => dispatch({ type: 'clear_recent_id', nodeId: screen.id })}
                        >
                            {renamingId === screen.id ? (
                                <input
                                    ref={renameInputRef}
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    onBlur={commitRename}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') commitRename();
                                        else if (e.key === 'Escape') setRenamingId(null);
                                    }}
                                    aria-label={t('app_studio.screens.name_aria', 'Screen name')}
                                    className="mx-0.5 my-0.5 w-32 rounded border px-2 py-0.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                                    style={{
                                        background: 'var(--bg-secondary)',
                                        borderColor: 'var(--editor-accent)',
                                        color: 'var(--text-primary)',
                                    }}
                                />
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        ref={(el) => { tabRefs.current[screen.id] = el; }}
                                        disabled={streamLock}
                                        onClick={() => dispatch({ type: 'set_screen', screenId: screen.id })}
                                        onDoubleClick={() => !streamLock && startRename(screen)}
                                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md py-1 pl-2.5 pr-1 disabled:opacity-50"
                                        style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                                        aria-current={active ? 'page' : undefined}
                                    >
                                        {screen.icon ? <AppIcon name={screen.icon} className="h-3 w-3 shrink-0" /> : null}
                                        <span className="max-w-[10rem] truncate">{screen.name || untitled}</span>
                                        {isHome ? (
                                            <Home
                                                className="h-3 w-3 shrink-0"
                                                aria-label={t('app_studio.screens.home_aria', 'Home screen')}
                                                style={{ color: active ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
                                            />
                                        ) : null}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={streamLock}
                                        aria-label={t('app_studio.screens.options_aria', 'Screen options for {name}', { name: screen.name || untitled })}
                                        title={t('app_studio.screens.options', 'Screen options')}
                                        aria-haspopup="menu"
                                        aria-expanded={menuFor === screen.id}
                                        onClick={(e) => {
                                            menuAnchorRef.current = e.currentTarget;
                                            setMenuFor(menuFor === screen.id ? null : screen.id);
                                        }}
                                        onPointerDown={(e) => e.stopPropagation()}
                                        className={`mr-1 rounded p-0.5 transition-opacity hover:bg-[var(--bg-card-hover)] disabled:opacity-0 ${active || menuFor === screen.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'}`}
                                        style={{ color: 'var(--text-tertiary)' }}
                                    >
                                        <MoreHorizontal className="h-3 w-3" />
                                    </button>
                                </>
                            )}
                        </DroppableTab>
                    );
                })}
            </div>

            <button
                type="button"
                onClick={handleAdd}
                disabled={streamLock}
                aria-label={t('app_studio.screens.add', 'Add screen')}
                title={t('app_studio.screens.add', 'Add screen')}
                className="inline-flex shrink-0 items-center rounded-md px-2 py-1 hover:bg-[var(--bg-card-hover)] disabled:opacity-50"
                style={{ color: 'var(--text-tertiary)' }}
            >
                <Plus className="h-3 w-3" />
            </button>

            <AnchoredMenu
                open={!!menuScreen}
                onClose={() => setMenuFor(null)}
                anchorRef={menuAnchorRef}
                align="left"
                role="menu"
                minWidth={176}
                className="py-1"
                style={{ background: 'var(--bg-secondary)' }}
            >
                {menuScreen ? (
                    <>
                        <MenuItem icon={Pencil} label={t('app_studio.screens.rename', 'Rename')} onClick={() => startRename(menuScreen)} />
                        <MenuItem
                            icon={Home}
                            label={t('app_studio.screens.set_home', 'Set as home screen')}
                            disabled={definition?.homeScreenId === menuScreen.id}
                            onClick={() => handleSetHome(menuScreen.id)}
                        />
                        <MenuItem
                            icon={PanelsTopLeft}
                            label={t('app_studio.screens.manage_nav', 'Manage navigation…')}
                            onClick={() => {
                                setMenuFor(null);
                                setManagingNav(true);
                            }}
                        />
                        <MenuItem
                            icon={Trash2}
                            label={t('app_studio.screens.delete', 'Delete screen')}
                            danger
                            disabled={screens.length <= 1}
                            title={screens.length <= 1 ? t('app_studio.screens.last_screen', 'An app needs at least one screen') : undefined}
                            onClick={() => {
                                setMenuFor(null);
                                setConfirmDeleteId(menuScreen.id);
                            }}
                        />
                    </>
                ) : null}
            </AnchoredMenu>

            <NavGroupsDialog
                open={managingNav}
                definition={definition}
                onCommit={onCommit}
                onClose={() => setManagingNav(false)}
            />

            <ConfirmDialog
                open={!!confirmDeleteId}
                title={t('app_studio.screens.delete_title', 'Delete “{name}”?', { name: deletingScreen?.name || t('app_studio.screens.this_screen', 'this screen') })}
                description={t('app_studio.screens.delete_desc', 'The screen and everything on it are removed from the app. You can undo this.')}
                confirmLabel={t('app_studio.screens.delete', 'Delete screen')}
                destructive
                onConfirm={handleDelete}
                onCancel={() => setConfirmDeleteId(null)}
            />
        </div>
    );

    if (inline) return strip;
    return (
        <div
            className="flex shrink-0 items-center border-b px-2 py-1.5"
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-primary)' }}
        >
            {strip}
        </div>
    );
}

function MenuItem({ icon, label, onClick, disabled = false, danger = false, title }) {
    const Icon = icon;
    return (
        <button
            type="button"
            role="menuitem"
            disabled={disabled}
            title={title}
            onClick={onClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-card-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            style={{ color: danger ? 'var(--error)' : 'var(--text-primary)' }}
        >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {label}
        </button>
    );
}

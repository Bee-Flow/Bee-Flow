/**
 * NotebookWorkspace — the universal, editor-agnostic workspace shell for
 * Notebooks + Legal (+ the embedded variant). It owns layout only: the shared
 * Studio object header (StudioSectionHeader, the same row agents, tables and
 * documents open with), toggleable left/right drawers, a centered editor column (children), a
 * ⌘K command palette, banners and an overlays slot. It never imports a concrete
 * editor — the page passes the editor as `children` — so both engines work.
 *
 * The "bold" distraction-free feel comes from the drawers collapsing away to
 * leave the centered editor canvas; the editor centres its own content.
 */
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
    PanelLeft, MessageSquare, Command as CommandIcon,
} from 'lucide-react';
import StudioSectionHeader from '../../../components/shared/StudioSectionHeader';
import useTranslation from '../../../hooks/useTranslation';
import useViewport from '../../../hooks/useViewport';
import useDrawerState from './hooks/useDrawerState';
import useResizableWidth from './hooks/useResizableWidth';
import Drawer from './shell/Drawer';
import CommandPalette from './shell/CommandPalette';
import buildCommands from './shell/buildCommands';

const LEFT_WIDTH = 272;

/* ── A header toggle button with active highlight ─────────────── */
function HeaderToggle({ icon: Icon, label, active, disabled, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`grid place-items-center w-8 h-8 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40 ${
                active ? 'bg-[var(--bg-tertiary)] text-[var(--accent-primary)]' : 'bg-transparent text-[var(--text-secondary)]'
            }`}
            title={label}
            aria-label={label}
            aria-pressed={!!active}
        >
            <Icon className="w-4 h-4" aria-hidden="true" />
        </button>
    );
}

export default function NotebookWorkspace({
    variant = 'notebook',
    kind = 'document',          // the Studio kind: tile colour + glyph (kindColors)
    icon,                       // optional glyph overriding the kind's own
    title,                      // the object's name (string)
    onRename,                   // (name) => void; omitted -> the name is plain text
    renameRequest = 0,          // bump to open the inline rename (command palette)
    onBack,
    backLabel,
    statusChip = null,          // node beside the name: chips, presence, save status
    headerActions,
    headerExtras = [],          // [{ id, icon, label, active, disabled, onClick }]
    leftDrawer,                 // { label, icon, node } | null
    rightDrawer,                // { label, icon, node } | null
    secondaryLeft = null,       // optional node between left drawer and editor (e.g. TOC)
    secondaryRight = null,      // optional node between editor and right drawer (e.g. comments)
    commandContext = null,      // passed to buildCommands; shell injects view toggles
    banners = null,
    overlays = null,
    children,                   // the editor
}) {
    const { t } = useTranslation();
    const { isDesktop } = useViewport();
    const { leftOpen, rightOpen, toggleLeft: toggleLeftDesktop, toggleRight: toggleRightDesktop } = useDrawerState(variant);
    const { width: rightWidth, startDrag } = useResizableWidth({
        initial: 320, min: 280, max: 760, side: 'right', storageKey: `bf.workspace.${variant}.rightWidth`,
    });
    const [paletteOpen, setPaletteOpen] = useState(false);

    // Below desktop the drawers become overlays, one at a time, defaulting closed
    // so the editor canvas owns the screen. On desktop they're persistent push
    // panels remembered per surface.
    const [overlayDrawer, setOverlayDrawer] = useState(null); // 'left' | 'right' | null
    const drawerMode = isDesktop ? 'push' : 'overlay';
    const leftEffectiveOpen = isDesktop ? leftOpen : overlayDrawer === 'left';
    const rightEffectiveOpen = isDesktop ? rightOpen : overlayDrawer === 'right';
    const closeOverlay = useCallback(() => setOverlayDrawer(null), []);
    const toggleLeft = useCallback(() => {
        if (isDesktop) toggleLeftDesktop();
        else setOverlayDrawer((d) => (d === 'left' ? null : 'left'));
    }, [isDesktop, toggleLeftDesktop]);
    const toggleRight = useCallback(() => {
        if (isDesktop) toggleRightDesktop();
        else setOverlayDrawer((d) => (d === 'right' ? null : 'right'));
    }, [isDesktop, toggleRightDesktop]);

    const hasRight = !!rightDrawer;
    // ⌘K / Ctrl+K toggles the palette, ⌘J / Ctrl+J the chat, from anywhere
    // in the workspace.
    useEffect(() => {
        const onKey = (e) => {
            if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
            if (e.key === 'k' || e.key === 'K') {
                e.preventDefault();
                setPaletteOpen((p) => !p);
            } else if ((e.key === 'j' || e.key === 'J') && hasRight) {
                e.preventDefault();
                toggleRight();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [hasRight, toggleRight]);

    const commands = useMemo(() => {
        if (!commandContext) return [];
        return buildCommands({
            ...commandContext,
            t,
            onToggleLeft: leftDrawer ? toggleLeft : undefined,
            onToggleRight: rightDrawer ? toggleRight : undefined,
        });
    }, [commandContext, t, leftDrawer, rightDrawer, toggleLeft, toggleRight]);

    return (
        <div className="h-full flex flex-col bg-[var(--bg-primary)]">
            {/* ── Header: the shared Studio object header ── */}
            <StudioSectionHeader
                kind={kind}
                icon={icon}
                title={title}
                onRename={onRename}
                renameRequest={renameRequest}
                statusChip={statusChip}
                onBack={onBack}
                backLabel={backLabel || t('notebooks.back_to_documents', 'Documents')}
                testId="notebook-header"
                extras={(
                    <>
                        <div className="flex items-center gap-0.5 shrink-0" role="toolbar" aria-label={t('notebooks.view_toggles', 'Panels')}>
                            {leftDrawer && (
                                <HeaderToggle icon={leftDrawer.icon || PanelLeft} label={leftDrawer.label || t('notebooks.toggle_sources', 'Toggle Sources')} active={leftEffectiveOpen} onClick={toggleLeft} />
                            )}
                            {headerExtras.map((x) => (
                                <HeaderToggle key={x.id} icon={x.icon} label={x.label} active={x.active} disabled={x.disabled} onClick={x.onClick} />
                            ))}
                            {rightDrawer && (
                                <HeaderToggle icon={rightDrawer.icon || MessageSquare} label={rightDrawer.label || t('notebooks.toggle_chat', 'Toggle AI Chat')} active={rightEffectiveOpen} onClick={toggleRight} />
                            )}
                            {commandContext && (
                                <HeaderToggle icon={CommandIcon} label={t('notebooks.command_palette', 'Command palette (⌘K)')} active={paletteOpen} onClick={() => setPaletteOpen(true)} />
                            )}
                        </div>
                        {headerActions}
                    </>
                )}
            />

            {/* ── Banners ── */}
            {banners}

            {/* ── Body ── */}
            <div className="flex-1 flex overflow-hidden relative">
                {leftDrawer && (
                    <Drawer side="left" open={leftEffectiveOpen} width={LEFT_WIDTH} mode={drawerMode} onClose={closeOverlay} label={leftDrawer.label}>
                        {leftDrawer.node}
                    </Drawer>
                )}
                {secondaryLeft}
                <div className="flex-1 min-w-0 flex flex-col overflow-hidden bg-[var(--bg-primary)]">
                    {children}
                </div>
                {secondaryRight}
                {rightDrawer && (
                    <Drawer side="right" open={rightEffectiveOpen} width={isDesktop ? rightWidth : Math.min(rightWidth, 380)} resizable={isDesktop} mode={drawerMode} onResizeStart={startDrag} onClose={closeOverlay} label={rightDrawer.label}>
                        {rightDrawer.node}
                    </Drawer>
                )}
            </div>

            {/* ── Command palette ── */}
            {commandContext && (
                <CommandPalette
                    open={paletteOpen}
                    onClose={() => setPaletteOpen(false)}
                    commands={commands}
                    placeholder={t('notebooks.command_palette_placeholder', 'Type a command…')}
                    emptyText={t('notebooks.command_palette_empty', 'No matching commands')}
                />
            )}

            {overlays}
        </div>
    );
}

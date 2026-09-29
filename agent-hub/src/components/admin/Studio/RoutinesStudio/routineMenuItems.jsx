import React from 'react';
import { Trash2, Copy, Code2, Hash, Pause, Play, History, FolderInput } from 'lucide-react';

/**
 * The per-routine actions menu, in one place.
 *
 * The sidebar row (RoutineRow), the in-editor flyout and every view of the
 * overview (list, cards, board) open the same menu from the same callbacks —
 * index.jsx builds those once in `makeAutomationRowProps`. Keeping the item
 * list here is what stops a fourth surface from growing a menu that is
 * missing "Move to folder…" or spells "Activate" differently.
 *
 * Items are omitted, not disabled, when their callback is absent: a prompt
 * task has no Activate/Pause, and a reader without manage rights gets no
 * Delete. The caller decides which callbacks to hand over; this only draws.
 */
export function buildRoutineMenuItems({
    isAutomation = true,
    isActive = false,
    onToggleActive,
    onOpenRuns,
    onDuplicate,
    onExportJson,
    onMoveToFolder,
    onCopyId,
    onDelete,
} = {}) {
    const items = [];
    if (isAutomation && onToggleActive) {
        items.push({
            label: isActive ? 'Pause' : 'Activate',
            icon: isActive ? <Pause size={13} /> : <Play size={13} />,
            onClick: onToggleActive,
        });
    }
    if (onOpenRuns) items.push({ label: 'View executions', icon: <History size={13} />, onClick: onOpenRuns });
    if (onDuplicate) items.push({ label: 'Duplicate', icon: <Copy size={13} />, onClick: onDuplicate });
    if (onExportJson) items.push({ label: 'Export JSON', icon: <Code2 size={13} />, onClick: onExportJson });
    // The keyboard-reachable twin of dragging a row onto a folder. Dragging
    // is the discoverable gesture; this is the one that always works.
    if (onMoveToFolder) items.push({ label: 'Move to folder…', icon: <FolderInput size={13} />, onClick: onMoveToFolder });
    if (onCopyId) items.push({ label: 'Copy ID', icon: <Hash size={13} />, onClick: onCopyId });
    if (onDelete) {
        if (items.length) items.push({ separator: true });
        items.push({ label: 'Delete', icon: <Trash2 size={13} />, onClick: onDelete, danger: true });
    }
    return items;
}

import { Redo2, Undo2 } from 'lucide-react';
import { CompactComponentBar } from './ComponentRibbon';
import ScreenTabs from './ScreenTabs';
import IconButton from '../../../../shared/IconButton';
import { useAppEditor } from '../state/AppEditorContext';
import useTranslation from '../../../../../hooks/useTranslation';

/**
 * App Studio editor — the SECOND ROW under the header (Studio artboard 1b):
 *
 *   undo · redo │ screen pills (+) │ COMPONENTS  chip × 8 … All components  🔍
 *
 * 48px, `gap 8px`, `padding 0 12px`, hairline dividers 1×20. It exists only
 * while the canvas is being EDITED — preview, and the Data / Logic / Roles
 * views, have no palette and no screen pills (the header decides; it mounts
 * this row next to itself so undo/redo and the palette share one line).
 *
 * The row `flex-wrap`s for the same reason the header does: it sits between
 * the chat pane and the inspector, and the full ribbon that "All components"
 * unfolds is a `basis-full` child that takes the next line.
 */
export default function EditorToolRow({ onCommit, canUndo, canRedo, onUndo, onRedo }) {
    const { t } = useTranslation();
    const { streamLock } = useAppEditor();
    return (
        <div
            className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs"
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-primary)' }}
            data-testid="editor-tool-row"
        >
            <div className="flex shrink-0 items-center gap-0.5">
                <IconButton ariaLabel={t('app_studio.header.undo', 'Undo')} size="sm" disabled={!canUndo || streamLock} onClick={onUndo}>
                    <Undo2 />
                </IconButton>
                <IconButton ariaLabel={t('app_studio.header.redo', 'Redo')} size="sm" disabled={!canRedo || streamLock} onClick={onRedo}>
                    <Redo2 />
                </IconButton>
            </div>
            <span aria-hidden="true" className="h-5 w-px shrink-0" style={{ background: 'var(--border-default)' }} />
            <ScreenTabs onCommit={onCommit} inline />
            <span aria-hidden="true" className="h-5 w-px shrink-0" style={{ background: 'var(--border-default)' }} />
            <CompactComponentBar onCommit={onCommit} />
        </div>
    );
}

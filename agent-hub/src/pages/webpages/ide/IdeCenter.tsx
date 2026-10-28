import { useMemo, useRef, type RefObject } from 'react';
import useTranslation from '@/hooks/useTranslation';
import EditorTabs from '../EditorTabs';
import WebpageCodeStrip, { fileDecorations, type MarksState } from '../WebpageCodeStrip';
import WebpageEditor from '../WebpageEditor';
import WebpagePreview from '../WebpagePreview';
import { BinaryPreview, MissingFile, ResizeHandle } from './IdeChrome';
import type { ActiveView, FileKey } from './ideFiles';
import type { WebpageIDEProps } from './ideProps';
import { useRowDragResize } from './resizeHooks';

const PREVIEW_MIN = 100;
const THEME = 'light';

interface IdeCenterProps extends Pick<WebpageIDEProps, 'selected' | 'html' | 'css' | 'js' | 'onSelectionAttach' | 'chatLoading'> {
    devMode: boolean;
    isOwner: boolean;
    extraFiles: NonNullable<WebpageIDEProps['extraFiles']>;
    extraContents: NonNullable<WebpageIDEProps['extraContents']>;
    dirtyFiles: Record<string, boolean>;
    bfMarks: MarksState;
    files: { openFiles: FileKey[]; activeKey: FileKey | null; setActiveKey: (key: FileKey) => void; openFile: (key: FileKey) => void; closeFile: (key: FileKey) => void };
    activeView: ActiveView | null;
    onCursorChange: (cursor: { line: number; col: number }) => void;
}

/** The editor pane for the active tab: Monaco, a binary card, or "not loaded yet". */
function EditorPane({ view, decorations, onCursorChange }: { view: ActiveView; decorations: unknown; onCursorChange: IdeCenterProps['onCursorChange'] }) {
    if (view.kind === 'text') {
        return (
            <WebpageEditor
                value={view.value}
                language={view.language}
                onChange={view.onChange}
                theme={THEME}
                onCursorChange={onCursorChange}
                decorations={decorations}
            />
        );
    }
    if (view.kind === 'binary') {
        return <BinaryPreview path={view.path} mimeType={view.mimeType} dataUrl={view.dataUrl} size={view.size} />;
    }
    return <MissingFile path={view.path} />;
}

/** Center column: the file strip, the editor tabs and editor, and the preview stacked below. */
export default function IdeCenter(p: IdeCenterProps) {
    const { t } = useTranslation();
    const { devMode, selected, files, activeView } = p;
    const editorOpen = files.activeKey !== null;
    // Editor/preview split (percentage of center column)
    const centerRef: RefObject<HTMLDivElement | null> = useRef<HTMLDivElement | null>(null);
    const [editorPct, onEditorPreviewDrag, onEditorPreviewKey] = useRowDragResize(60, PREVIEW_MIN, centerRef);
    const decorations = useMemo(
        () => fileDecorations({ marks: p.bfMarks.marks, fileKey: files.activeKey, t }),
        [p.bfMarks.marks, files.activeKey, t],
    );
    return (
        <div className="flex flex-col flex-1 min-w-0 min-h-0" ref={centerRef}>
            {/* The file strip: the files this page REALLY has, with their
                bytes, plus the legend that says what the marks in the code
                mean — or why there are none. Shown even without an open tab:
                it is the shortest way to a file. */}
            {devMode && (
                <WebpageCodeStrip
                    framework={selected?.settings?.framework}
                    html={p.html} css={p.css} js={p.js}
                    extraFiles={p.extraFiles}
                    extraContents={p.extraContents}
                    marksState={p.bfMarks}
                    activeKey={files.activeKey}
                    onOpen={files.openFile}
                    dirtyFiles={p.dirtyFiles}
                    readOnly={!p.isOwner}
                />
            )}

            {/* Tabs only render when at least one tab is open (dev view). */}
            {devMode && editorOpen && (
                <EditorTabs
                    openFiles={files.openFiles}
                    activeKey={files.activeKey}
                    onSelect={files.setActiveKey}
                    onClose={files.closeFile}
                    dirtyFiles={p.dirtyFiles}
                />
            )}

            {devMode && editorOpen && activeView && (
                <>
                    <div style={{ flex: `0 0 ${editorPct}%`, minHeight: 0, overflow: 'hidden' }}>
                        <EditorPane view={activeView} decorations={decorations} onCursorChange={p.onCursorChange} />
                    </div>

                    {/* Editor/Preview resize handle */}
                    <ResizeHandle
                        orientation="horizontal"
                        onMouseDown={onEditorPreviewDrag}
                        onKeyDown={onEditorPreviewKey}
                        label={t('webpages.ide.resize_editor_preview', 'Resize editor and preview')}
                    />
                </>
            )}

            {/* Preview — always visible, full height when no editor is open */}
            <div className="[flex:1] min-h-[0] [overflow:hidden]">
                <WebpagePreview
                    webpageId={selected?.id}
                    html={p.html} css={p.css} js={p.js}
                    extraFiles={p.extraFiles}
                    extraContents={p.extraContents}
                    onSelectionAttach={p.onSelectionAttach}
                    framework={selected?.settings?.framework}
                    runtime={selected?.settings?.runtime}
                    isStreaming={p.chatLoading}
                />
            </div>
        </div>
    );
}

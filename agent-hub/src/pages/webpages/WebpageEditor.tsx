import React, { Suspense, type ComponentProps, type ComponentType, useCallback, useEffect, useRef, useState } from 'react';
import type MonacoReact from '@monaco-editor/react';
import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoNs } from 'monaco-editor';
import { useTranslation } from '../../hooks/useTranslation';
import { lazy } from '../../utils/lazyWithReload';
import { logger } from '../../utils/logger';

type MonacoProps = ComponentProps<typeof MonacoReact> & { onLoadFailed?: () => void };

// Stands in for Monaco when its chunk cannot be loaded (blocked CDN, offline,
// bad deploy). `React.lazy` must resolve to a component, so it reports the
// failure upward and the editor swaps in the plain textarea.
function MonacoUnavailable({ onLoadFailed }: MonacoProps) {
    useEffect(() => { onLoadFailed?.(); }, [onLoadFailed]);
    return null;
}

const MonacoEditor = lazy((): Promise<{ default: ComponentType<MonacoProps> }> =>
    import('@monaco-editor/react')
        .then(m => {
            if (!m.default) throw new Error('Monaco default export missing');
            return { default: m.default };
        })
        .catch(err => {
            console.error('[WebpageEditor] Monaco failed to load:', err);
            return { default: MonacoUnavailable };
        })
);

/**
 * Apply and re-apply line markers.
 *
 * Returns the applier BACK instead of relying only on an effect. Monaco is loaded lazily, so the decorations are usually there earlier than the editor; `onMount` therefore calls this function itself as soon as the editor exists. That saves a bit of state, and with it an extra render — and the first version with that state ran in the test straight into "Maximum update depth exceeded" as soon as `onMount` came more than once.
 *
 * All in a try: a Monaco without this API may cost at most the markers, never the editor itself — the author must be able to keep typing, even when there is nothing to shade.
 */
function useDecorations(
    editorRef: React.RefObject<MonacoNs.IStandaloneCodeEditor | null>,
    decorations: unknown,
    monacoFailed: boolean,
) {
    const collectionRef = useRef<MonacoNs.IEditorDecorationsCollection | null>(null);

    const apply = useCallback((fresh = false) => {
        const editor = editorRef.current;
        if (!editor || monacoFailed) return;
        // A new editor means a new collection: the old one belonged to an instance that
        // no longer exists.
        if (fresh) collectionRef.current = null;
        const items = Array.isArray(decorations) ? decorations : [];
        try {
            if (collectionRef.current) collectionRef.current.set(items);
            else if (typeof editor.createDecorationsCollection === 'function') {
                collectionRef.current = editor.createDecorationsCollection(items);
            }
        } catch (err) {
            console.warn('[WebpageEditor] decorations could not be applied:', err);
        }
    }, [editorRef, decorations, monacoFailed]);

    useEffect(() => { apply(); }, [apply]);

    useEffect(() => () => {
        try { collectionRef.current?.clear(); } catch (err) { logger.debug('de editor is al weg', err); }
        collectionRef.current = null;
    }, []);

    return apply;
}

interface WebpageEditorProps {
    value?: string;
    language?: string;
    onChange?: (value: string) => void;
    readOnly?: boolean;
    theme?: string;
    onCursorChange?: (cursor: { line: number; col: number }) => void;
    decorations?: unknown;
}

/**
 * Generic Monaco editor for any text file in the webpage project. Caller resolves the file → value + language; the editor doesn't know about primary slots vs extras.
 *
 * `decorations` are READY-MADE Monaco decorations (`{ range, options }`). This editor deliberately knows nothing of `bf-*`: what is marked comes from the server (`core/webpages/webpageBindings.js`) and is brought into this form by `WebpageCodeStrip.fileDecorations`. So there need not be a second reading of the vocabulary here.
 */
export default function WebpageEditor({
    value = '',
    language = 'plaintext',
    onChange,
    readOnly = false,
    theme = 'light',
    onCursorChange,
    decorations = null,
}: WebpageEditorProps) {
    const { t } = useTranslation();
    const editorRef = useRef<MonacoNs.IStandaloneCodeEditor | null>(null);
    const [monacoFailed, setMonacoFailed] = useState(false);

    const applyDecorations = useDecorations(editorRef, decorations, monacoFailed);

    const handleMount = (editor: MonacoNs.IStandaloneCodeEditor, monaco: Monaco) => {
        if (!editor) { setMonacoFailed(true); return; }
        editorRef.current = editor;
        // De editor is er nu pas; wat er al aan markeringen klaarlag, hoort er
        // meteen op te staan in plaats van bij de volgende wijziging.
        applyDecorations(true);
        try {
            monaco.languages.html.htmlDefaults.setOptions({
                format: { tabSize: 2, insertSpaces: true, wrapLineLength: 120 },
                suggest: { html5: true },
            });
        } catch (err) { logger.debug('Monaco HTML options unsupported', err); }
        try {
            monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
                noSemanticValidation: true,
                noSyntaxValidation: false,
            });
        } catch (err) { logger.debug('Monaco diagnostics options unsupported', err); }
        if (onCursorChange) {
            editor.onDidChangeCursorPosition((e: MonacoNs.ICursorPositionChangedEvent) => {
                onCursorChange({ line: e.position.lineNumber, col: e.position.column });
            });
        }
    };

    return (
        <div className="flex flex-col h-full min-h-0 bg-[var(--vsc-editor-bg)]">
            <div className="flex-1 min-h-0">
                {monacoFailed ? (
                    <textarea
                        className="w-full h-full p-3 text-xs font-mono resize-none outline-none [background:var(--vsc-editor-bg)] [color:var(--vsc-fg)]!"
                        value={value}
                        readOnly={readOnly}
                        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange?.(e.target.value)}
                        spellCheck={false}
                    />
                ) : (
                    <Suspense fallback={<div className="p-4 text-xs text-[var(--vsc-fg-muted)]">{t('webpages.editor_loading', 'Loading editor…')}</div>}>
                        <MonacoEditor
                            height="100%"
                            language={language}
                            value={value}
                            onChange={(v: string | undefined) => onChange?.(v ?? '')}
                            onLoadFailed={() => setMonacoFailed(true)}
                            onMount={(editor: MonacoNs.IStandaloneCodeEditor, monaco: Monaco) => {
                                if (!editor) { setMonacoFailed(true); return; }
                                handleMount(editor, monaco);
                            }}
                            theme={theme === 'dark' ? 'vs-dark' : 'vs'}
                            options={{
                                readOnly,
                                minimap: { enabled: false },
                                fontSize: 13,
                                wordWrap: 'on',
                                scrollBeyondLastLine: false,
                                automaticLayout: true,
                                tabSize: 2,
                                insertSpaces: true,
                                renderWhitespace: 'selection',
                                formatOnPaste: true,
                                formatOnType: false,
                                quickSuggestions: { other: true, comments: false, strings: false },
                            }}
                        />
                    </Suspense>
                )}
            </div>
        </div>
    );
}

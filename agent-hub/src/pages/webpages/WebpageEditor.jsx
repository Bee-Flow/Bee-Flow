import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { lazy } from '../../utils/lazyWithReload';

const MonacoEditor = lazy(() =>
    import('@monaco-editor/react')
        .then(m => {
            if (!m.default) throw new Error('Monaco default export missing');
            return { default: m.default };
        })
        .catch(err => {
            console.error('[WebpageEditor] Monaco failed to load:', err);
            return { default: null };
        })
);

/**
 * Regelmarkeringen aan- en bijzetten.
 *
 * Geeft de toepasser TERUG in plaats van alleen op een effect te leunen. Monaco
 * wordt lui geladen, dus de decoraties zijn er meestal eerder dan de editor;
 * `onMount` roept deze functie daarom zelf aan zodra de editor bestaat. Dat
 * scheelt een stukje state en daarmee een extra render — en de eerste versie
 * mét die state liep in de test meteen tegen "Maximum update depth exceeded"
 * aan zodra `onMount` vaker dan één keer kwam.
 *
 * Alles in een try: een Monaco zonder deze API mag hoogstens de markeringen
 * kosten, nooit de editor zelf — de auteur moet kunnen blijven typen, ook als
 * er niets te tinten valt.
 */
function useDecorations(editorRef, decorations, monacoFailed) {
    const collectionRef = useRef(null);

    const apply = useCallback((fresh = false) => {
        const editor = editorRef.current;
        if (!editor || monacoFailed) return;
        // Een nieuwe editor betekent een nieuwe verzameling: de oude hoorde bij
        // een instantie die niet meer bestaat.
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
        try { collectionRef.current?.clear(); } catch { /* de editor is al weg */ }
        collectionRef.current = null;
    }, []);

    return apply;
}

/**
 * Generic Monaco editor for any text file in the webpage project. Caller
 * resolves the file → value + language; the editor doesn't know about
 * primary slots vs extras.
 *
 * `decorations` zijn KANT-EN-KLARE Monaco-decoraties (`{ range, options }`).
 * Deze editor weet met opzet niets van `bf-*`: wat er gemarkeerd wordt, komt
 * van de server (`core/webpages/webpageBindings.js`) en wordt door
 * `WebpageCodeStrip.fileDecorations` in deze vorm gebracht. Zo hoeft hier geen
 * tweede lezing van het vocabulaire te bestaan.
 */
export default function WebpageEditor({
    value = '',
    language = 'plaintext',
    onChange,
    readOnly = false,
    theme = 'light',
    onCursorChange,
    decorations = null,
}) {
    const editorRef = useRef(null);
    const [monacoFailed, setMonacoFailed] = useState(false);

    const applyDecorations = useDecorations(editorRef, decorations, monacoFailed);

    const handleMount = (editor, monaco) => {
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
        } catch (_) {}
        try {
            monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
                noSemanticValidation: true,
                noSyntaxValidation: false,
            });
        } catch (_) {}
        if (onCursorChange) {
            editor.onDidChangeCursorPosition(e => {
                onCursorChange({ line: e.position.lineNumber, col: e.position.column });
            });
        }
    };

    return (
        <div className="flex flex-col h-full min-h-0" style={{ background: 'var(--vsc-editor-bg)' }}>
            <div className="flex-1 min-h-0">
                {monacoFailed ? (
                    <textarea
                        className="w-full h-full p-3 text-xs font-mono resize-none outline-none"
                        style={{ background: 'var(--vsc-editor-bg)', color: 'var(--vsc-fg)' }}
                        value={value}
                        readOnly={readOnly}
                        onChange={(e) => onChange?.(e.target.value)}
                        spellCheck={false}
                    />
                ) : (
                    <Suspense fallback={<div className="p-4 text-xs" style={{ color: 'var(--vsc-fg-muted)' }}>Loading editor…</div>}>
                        <MonacoEditor
                            height="100%"
                            language={language}
                            value={value}
                            onChange={(v) => onChange?.(v ?? '')}
                            onMount={(editor, monaco) => {
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

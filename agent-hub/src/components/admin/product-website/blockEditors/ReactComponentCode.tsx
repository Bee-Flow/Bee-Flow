// The TSX box of the React component block: Monaco (lazy, served by this app,
// see codeStep/monaco.tsx) with the compiler's errors as markers, or a plain
// monospace textarea when Monaco cannot load or never mounts.
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { MONACO_MOUNT_DEADLINE_MS, MonacoEditor, monacoOptions, monacoTheme } from '@/components/automation/Builder/flow/settings/codeStep/monaco';
import { MonoTextarea } from '../primitives';
import type { EditorMarker } from './reactComponentModel';

export interface ReactCodeEditorProps {
    value: string;
    onChange: (value: string) => void;
    markers: EditorMarker[];
    ariaLabel: string;
}

type TsDefaults = {
    getCompilerOptions?: () => Record<string, unknown>;
    setCompilerOptions?: (o: Record<string, unknown>) => void;
    getDiagnosticsOptions?: () => Record<string, unknown>;
    setDiagnosticsOptions?: (o: Record<string, unknown>) => void;
};
type TsNamespace = {
    typescriptDefaults?: TsDefaults;
    JsxEmit?: { ReactJSX?: number };
    ScriptTarget?: { ES2020?: number };
    ModuleKind?: { ESNext?: number };
};
type MonacoNs = {
    typescript?: TsNamespace;
    languages?: { typescript?: TsNamespace };
    editor?: { setModelMarkers?: (model: unknown, owner: string, markers: EditorMarker[]) => void };
};
type EditorLike = { getModel?: () => unknown };

const MARKER_OWNER = 'cms-react';

/** The TypeScript namespace: top level since Monaco 0.55, under `languages` before. */
function tsOf(monaco: MonacoNs | null): TsNamespace | null {
    const ns = monaco?.typescript?.typescriptDefaults ? monaco.typescript : monaco?.languages?.typescript;
    return ns && ns.typescriptDefaults ? ns : null;
}

/**
 * TSX without false alarms: JSX on, and no semantic checks (the editor has no
 * React types, so every import would be red). Syntax errors stay, and the
 * compiler's own errors arrive as markers. The settings are global to Monaco,
 * so the previous ones come back when this editor goes.
 */
function configureTsx(monaco: MonacoNs | null): (() => void) | null {
    const ts = tsOf(monaco);
    const defaults = ts?.typescriptDefaults;
    if (!ts || !defaults?.setCompilerOptions || !defaults.setDiagnosticsOptions) return null;
    const prevCompiler = defaults.getCompilerOptions?.() || {};
    const prevDiagnostics = defaults.getDiagnosticsOptions?.() || {};
    defaults.setCompilerOptions({
        ...prevCompiler,
        jsx: ts.JsxEmit?.ReactJSX,
        target: ts.ScriptTarget?.ES2020,
        module: ts.ModuleKind?.ESNext,
        allowNonTsExtensions: true,
        allowJs: true,
        esModuleInterop: true,
    });
    defaults.setDiagnosticsOptions({ ...prevDiagnostics, noSemanticValidation: true, noSyntaxValidation: false });
    return () => {
        defaults.setCompilerOptions?.(prevCompiler);
        defaults.setDiagnosticsOptions?.(prevDiagnostics);
    };
}

export default function ReactComponentCode({ value, onChange, markers, ariaLabel }: ReactCodeEditorProps) {
    const { t } = useTranslation();
    const [failed, setFailed] = useState(false);
    const [mounted, setMounted] = useState(false);
    const editorRef = useRef<EditorLike | null>(null);
    const monacoRef = useRef<MonacoNs | null>(null);
    const restoreRef = useRef<(() => void) | null>(null);

    // Monaco's runtime comes from this app; when it never arrives, the textarea takes over.
    useEffect(() => {
        if (failed || mounted) return undefined;
        const timer = setTimeout(() => setFailed(true), MONACO_MOUNT_DEADLINE_MS);
        return () => clearTimeout(timer);
    }, [failed, mounted]);

    useEffect(() => () => { restoreRef.current?.(); restoreRef.current = null; }, []);

    useEffect(() => {
        const model = editorRef.current?.getModel?.();
        if (!mounted || !model) return;
        monacoRef.current?.editor?.setModelMarkers?.(model, MARKER_OWNER, markers);
    }, [markers, mounted]);

    const beforeMount = useCallback((monaco: unknown) => {
        restoreRef.current?.();
        restoreRef.current = configureTsx(monaco as MonacoNs);
    }, []);
    const onMount = useCallback((editor: unknown, monaco: unknown) => {
        if (!editor) { setFailed(true); return; }
        editorRef.current = editor as EditorLike;
        monacoRef.current = monaco as MonacoNs;
        setMounted(true);
    }, []);
    const onUnavailable = useCallback(() => setFailed(true), []);

    if (failed) {
        return (
            <>
                <MonoTextarea rows={18} minHeight={360} value={value} onChange={onChange} ariaLabel={ariaLabel} />
                <p className="text-xs text-[var(--text-muted)] mt-1">
                    {t('cms_site.blocks.react_component.editor_fallback', 'The code editor could not be loaded, so this is a plain text box. It edits and saves the same code.')}
                </p>
            </>
        );
    }
    return (
        <div className="rounded-md border border-[var(--border-default)] overflow-hidden">
            <Suspense fallback={<div className="text-xs text-[var(--text-muted)] p-3">{t('cms_site.blocks.react_component.editor_loading', 'Loading the code editor…')}</div>}>
                <MonacoEditor
                    height="420px"
                    language="typescript"
                    path="component.tsx"
                    value={value}
                    onChange={(v) => onChange(v ?? '')}
                    beforeMount={beforeMount}
                    onMount={onMount}
                    onUnavailable={onUnavailable}
                    theme={monacoTheme()}
                    options={monacoOptions(ariaLabel)}
                />
            </Suspense>
        </div>
    );
}

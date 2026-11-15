/**
 * The live compile of the React component block editor: the same compiler the
 * server runs on save (shared/cmsReact/compile.mjs), on esbuild-wasm in the
 * browser. Its output only drives the live preview and the error markers; the
 * server discards a client's `compiled` and compiles again on save.
 */
import { useEffect, useRef, useState } from 'react';
import { logger } from '@/utils/logger';
import type { CompileDiagnostic, CompileResult } from './reactComponentModel';

export type CompileFn = (source: string) => Promise<CompileResult>;

/** esbuild-wasm (~3 MB) and the compiler load on the first compile, never with the admin bundle. */
export const compileInBrowser: CompileFn = async (source) => {
    const [{ getEsbuild }, { compileReactBlock }] = await Promise.all([
        import('@/utils/esbuildWasm'),
        import('@shared/cmsReact/compile.mjs'),
    ]);
    return compileReactBlock(await getEsbuild(), source) as Promise<CompileResult>;
};

/** Quiet time after the last keystroke before the source is compiled (ms). */
export const COMPILE_DEBOUNCE_MS = 400;

export interface LiveCompileState {
    diagnostics: CompileDiagnostic[];
    /** A compile is waiting or running for the current source. */
    compiling: boolean;
    /** The browser could not load the compiler; the server still compiles on save. */
    unavailable: boolean;
}

/**
 * Compile `source` a moment after it stops changing, and hand each outcome to
 * `onResult` together with the source it belongs to (the caller drops an
 * outcome for a source that has moved on).
 */
export function useLiveCompile(
    source: string,
    compile: CompileFn,
    onResult: (source: string, result: CompileResult) => void,
): LiveCompileState {
    const [state, setState] = useState<LiveCompileState>({ diagnostics: [], compiling: false, unavailable: false });
    const onResultRef = useRef(onResult);
    useEffect(() => { onResultRef.current = onResult; }, [onResult]);

    useEffect(() => {
        let live = true;
        const timer = setTimeout(() => {
            if (!live) return;
            setState((s) => (s.compiling ? s : { ...s, compiling: true }));
            compile(source).then(
                (result) => {
                    if (!live) return;
                    setState({ diagnostics: result.diagnostics || [], compiling: false, unavailable: false });
                    onResultRef.current(source, result);
                },
                (err: unknown) => {
                    if (!live) return;
                    logger.warn('[ReactComponentEditor] the live compile is unavailable', err);
                    setState((s) => ({ ...s, compiling: false, unavailable: true }));
                },
            );
        }, COMPILE_DEBOUNCE_MS);
        return () => { live = false; clearTimeout(timer); };
    }, [source, compile]);

    return state;
}

import { useCallback, useEffect, useMemo, useRef, type ComponentType } from 'react';
import { ALLOWED_IMPORTS, REACT_THEME_VARS } from '@shared/cmsReact/compile.mjs';
import { useTranslation } from '@/hooks/useTranslation';
import { lazy } from '@/utils/lazyWithReload';
import { FieldRow } from '../fields';
import { CollapsibleCard, InlineHint, MonoTextarea, PxSizeInput, SegmentedControl } from '../primitives';
import type { BlockEditorWithPagesProps } from './editorProps';
import { ReactComponentFields, type FieldsChange } from './ReactComponentFields';
import { ReactComponentProps } from './ReactComponentProps';
import { compileInBrowser, useLiveCompile, type CompileFn } from './reactComponentCompile';
import { fieldsOf, markersFromDiagnostics, propsOf, type CompileResult, type ReactComponentData } from './reactComponentModel';
import type { ReactCodeEditorProps } from './ReactComponentCode';

// ── React component ───────────────────────────────────────────────────
//
// One TSX file with a default export, rendered by the site's own React in a
// sandboxed frame (marketing/sections/ReactComponent.tsx). The source is
// compiled here as the author types (esbuild-wasm, the server's compiler) so
// the live preview and the error markers follow every edit; the server
// compiles again on save and its result is the one that is published.
//
// Monaco and esbuild-wasm load only when this editor opens.

const ReactComponentCode = lazy(() => import('./ReactComponentCode'));

interface ReactComponentEditorProps extends BlockEditorWithPagesProps<ReactComponentData> {
    /** The compiler (tests hand a stand-in); esbuild-wasm in the browser by default. */
    compile?: CompileFn;
    /** The code box (tests hand a plain one); Monaco by default. */
    CodeEditor?: ComponentType<ReactCodeEditorProps>;
}

const MIN_HEIGHT_DEFAULT = 240;

/**
 * Write a compile outcome into the content, for the preview, unless it is
 * stale (the source moved on) or already there. On opening the editor the
 * stored outcome is the server's: that compile only sets the markers, so
 * opening a block never marks the page as changed.
 */
function useCompileWriter(data: ReactComponentData, onChange: (next: ReactComponentData) => void) {
    const dataRef = useRef(data);
    useEffect(() => { dataRef.current = data; }, [data]);
    const settledFor = useRef<string | null>(data.compiled || data.compileError ? (data.source || '') : null);
    return useCallback((source: string, result: CompileResult) => {
        const current = dataRef.current;
        if ((current.source || '') !== source) return;
        if (settledFor.current === source) return;
        settledFor.current = source;
        const compiled = result.ok ? result.code : '';
        const compileError = result.ok ? '' : result.error;
        if (current.compiled === compiled && current.compileError === compileError) return;
        onChange({ ...current, compiled, compileError });
    }, [onChange]);
}

function ImportsHint() {
    const { t } = useTranslation();
    return (
        <InlineHint>
            {t('cms_site.blocks.react_component.hint', 'One file with a default export. It may import only {imports}. The site theme is available as CSS variables: {vars}.', {
                imports: ALLOWED_IMPORTS.join(', '),
                vars: REACT_THEME_VARS.join(', '),
            })}
        </InlineHint>
    );
}

function LayoutCard({ data, set }: { data: ReactComponentData; set: (patch: ReactComponentData) => void }) {
    const { t } = useTranslation();
    return (
        <CollapsibleCard title={t('cms_site.blocks.react_component.layout', 'Layout')} persistKey="blk.react-component.layout">
            <FieldRow label={t('cms_site.blocks.react_component.width', 'Width')}>
                <SegmentedControl
                    value={data.width === 'full' ? 'full' : 'container'}
                    onChange={(v) => set({ width: v })}
                    options={[
                        { value: 'container', label: t('cms_site.blocks.react_component.width_container', 'Content width') },
                        { value: 'full', label: t('cms_site.blocks.react_component.width_full', 'Full width') },
                    ]}
                />
            </FieldRow>
            <FieldRow
                label={t('cms_site.blocks.react_component.min_height', 'Starting height (px)')}
                hint={t('cms_site.blocks.react_component.min_height_hint', 'The frame holds this height until the component reports its own, so the page does not jump.')}
            >
                <PxSizeInput
                    value={typeof data.minHeight === 'number' ? data.minHeight : MIN_HEIGHT_DEFAULT}
                    min={0}
                    max={4000}
                    onChange={(v) => set({ minHeight: v })}
                    ariaLabel={t('cms_site.blocks.react_component.min_height', 'Starting height (px)')}
                />
            </FieldRow>
        </CollapsibleCard>
    );
}

function CompileStatus({ error, compiling, unavailable }: { error: string; compiling: boolean; unavailable: boolean }) {
    const { t } = useTranslation();
    if (unavailable) {
        return <p className="text-xs text-[var(--text-muted)] mt-2">{t('cms_site.blocks.react_component.compile_unavailable', 'The live preview could not load its compiler. The code is still compiled when the page is saved.')}</p>;
    }
    if (error) {
        return <pre role="alert" className="mt-2 p-2 rounded-md text-xs whitespace-pre-wrap break-words font-mono border border-[var(--error)] bg-[var(--error)]/10 text-[var(--error)]">{error}</pre>;
    }
    return (
        <p className="text-xs text-[var(--text-muted)] mt-2" aria-live="polite">
            {compiling ? t('cms_site.blocks.react_component.compiling', 'Compiling…') : t('cms_site.blocks.react_component.compiled_ok', 'Compiles without errors.')}
        </p>
    );
}

export function ReactComponentEditor({ data = {}, pages = [], onChange, compile = compileInBrowser, CodeEditor = ReactComponentCode }: ReactComponentEditorProps) {
    const { t } = useTranslation();
    const set = (patch: ReactComponentData) => onChange({ ...data, ...patch });
    const source = typeof data.source === 'string' ? data.source : '';
    const fields = fieldsOf(data);
    const props = propsOf(data);

    const writeResult = useCompileWriter(data, onChange);
    const live = useLiveCompile(source, compile, writeResult);
    const markers = useMemo(() => markersFromDiagnostics(live.diagnostics), [live.diagnostics]);
    const shownError = live.compiling ? '' : (data.compileError || '');

    return (
        <>
            <ImportsHint />
            <CollapsibleCard title={t('cms_site.blocks.react_component.code', 'Code')} defaultOpen persistKey="blk.react-component.code">
                <CodeEditor
                    value={source}
                    onChange={(v) => set({ source: v })}
                    markers={markers}
                    ariaLabel={t('cms_site.blocks.react_component.code_aria', 'React component code (TSX)')}
                />
                <CompileStatus error={shownError} compiling={live.compiling} unavailable={live.unavailable} />
            </CollapsibleCard>
            <CollapsibleCard title={t('cms_site.blocks.react_component.props', 'Props')} defaultOpen persistKey="blk.react-component.props">
                <ReactComponentProps fields={fields} props={props} pages={pages} onChange={(next) => set({ props: next })} />
            </CollapsibleCard>
            <CollapsibleCard title={t('cms_site.blocks.react_component.fields', 'Fields')} persistKey="blk.react-component.fields">
                <ReactComponentFields fields={fields} props={props} onChange={(next: FieldsChange) => set(next)} />
            </CollapsibleCard>
            <CollapsibleCard title={t('cms_site.blocks.react_component.css', 'Stylesheet')} persistKey="blk.react-component.css">
                <FieldRow hint={t('cms_site.blocks.react_component.css_hint', 'Optional CSS for the frame only; it cannot reach the rest of the page.')}>
                    <MonoTextarea
                        rows={8}
                        value={data.css || ''}
                        onChange={(v) => set({ css: v })}
                        ariaLabel={t('cms_site.blocks.react_component.css', 'Stylesheet')}
                    />
                </FieldRow>
            </CollapsibleCard>
            <LayoutCard data={data} set={set} />
        </>
    );
}

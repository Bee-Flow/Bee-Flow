import { Suspense } from 'react';
import type { ComponentProps } from 'react';
import { lazy } from '../../../../utils/lazyWithReload';

// Monaco is ~16 KB minified but pulls a large worker dep chain. Defer
// loading until the user actually opens a tab that needs the editor —
// mirrors the pattern in pages/webpages/WebpageEditor.jsx.
const MonacoEditor = lazy(() => import('@monaco-editor/react'));

type EditorProps = ComponentProps<typeof import('@monaco-editor/react').default>;

function EditorFallback() {
    return (
        <div className="w-full h-full flex items-center justify-center">
            <div className="w-6 h-6 rounded-full border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] animate-spin" />
        </div>
    );
}

// Drop-in replacement so existing <Editor ...> JSX keeps working.
export default function Editor(props: EditorProps) {
    return (
        <Suspense fallback={<EditorFallback />}>
            <MonacoEditor {...props} />
        </Suspense>
    );
}

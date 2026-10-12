// The code box: a real editor, or a plain textarea, and the user decides.
//
// The plain path is NOT only the crash fallback. Monaco traps Tab by default
// (it indents) and its accessible mode is a compromise, and this product is
// justified by being usable by a less technical person, so "give me a plain
// box" is a first-class choice remembered per user. A keyboard user inside
// Monaco gets out with Ctrl+M (Cmd+M on macOS), which the hint under the
// editor says out loud. The switch sits ABOVE the editor so Shift+Tab reaches
// it from the code box in both modes.
//
// Three ways Monaco can leave the author with nothing, and each one hands the
// textarea over instead: the chunk is gone after a redeploy ('chunk'), Monaco
// mounts and hands us no editor ('stalled'), or the CDN runtime never arrives
// on an offline install (the deadline, 'stalled' too).
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { CodeAnalysis } from '../../../../../../api/queries/automation/codeStep';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import scopedStorage from '../../../../../../utils/scopedStorage';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import { SectionNote, hintTextClass, textareaClass } from '../formPrimitives';
import { lineRange, markersFor } from './codeMarkers';
import { EDITOR_PREF_KEY, MONACO_MOUNT_DEADLINE_MS, MonacoEditor, monacoOptions, monacoTheme } from './monaco';

export interface CodeEditorHandle {
    revealLine: (line: number, column?: number) => void;
}

type Failure = 'chunk' | 'stalled' | null;
type MonacoLike = { editor?: { setModelMarkers?: (model: unknown, owner: string, markers: unknown[]) => void } };
type EditorLike = {
    getModel?: () => unknown;
    revealLineInCenter?: (line: number) => void;
    setPosition?: (p: { lineNumber: number; column: number }) => void;
    focus?: () => void;
};

function useEditorChoice() {
    const [prefersPlain, setPrefersPlain] = useState(() => {
        try { return scopedStorage.getItem(EDITOR_PREF_KEY) === 'plain'; } catch { return false; }
    });
    // A reason, not a boolean: 'chunk' is final for this page load (React.lazy
    // caches the rejection), 'stalled' may work on the next try.
    const [failure, setFailure] = useState<Failure>(null);
    const [mounted, setMounted] = useState(false);
    const onUnavailable = useCallback(() => setFailure('chunk'), []);
    const plain = prefersPlain || failure !== null;

    // Armed only while we wait for an editor; cleared the moment one mounts.
    useEffect(() => {
        if (plain || mounted || failure) return undefined;
        const timer = setTimeout(() => setFailure(prev => prev || 'stalled'), MONACO_MOUNT_DEADLINE_MS);
        return () => clearTimeout(timer);
    }, [plain, mounted, failure]);

    const choose = (next: 'plain' | 'rich') => {
        setPrefersPlain(next === 'plain');
        // Asking for the editor back is a RETRY: without clearing the failure
        // the author would click an enabled control that does nothing.
        if (next === 'rich') { setFailure(null); setMounted(false); }
        try { scopedStorage.setItem(EDITOR_PREF_KEY, next); } catch { /* private mode */ }
    };
    return { plain, failure, setFailure, mounted, setMounted, onUnavailable, choose };
}

function FailureNote({ failure }: { failure: Failure }) {
    const { t } = useTranslation();
    if (failure === 'chunk') {
        return <SectionNote tone="warn">{t('code_step.editor.chunk_failed', 'The code editor could not be loaded, so this is the plain text box. Nothing is lost: it edits and saves exactly the same code.')}</SectionNote>;
    }
    if (failure === 'stalled') {
        return <SectionNote tone="warn">{t('code_step.editor.stalled', 'The code editor did not finish loading, so this is the plain text box. Reload the page to try again. Nothing is lost: this box edits and saves exactly the same code.')}</SectionNote>;
    }
    return null;
}

interface CodeEditorFieldProps {
    value: string;
    onChange: (v: string) => void;
    analysis?: CodeAnalysis | null;
    handleRef?: MutableRefObject<CodeEditorHandle | null>;
    /** Fill the parent's height (the large editor) instead of a fixed 280px box. */
    fill?: boolean;
}

export default function CodeEditorField({ value, onChange, analysis = null, handleRef, fill = false }: CodeEditorFieldProps) {
    const { t } = useTranslation();
    const choice = useEditorChoice();
    const editorRef = useRef<EditorLike | null>(null);
    const monacoRef = useRef<MonacoLike | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const markers = useMemo(() => markersFor(analysis, (key, english) => (key ? t(key, english) : english)), [analysis, t]);

    useEffect(() => {
        const model = editorRef.current?.getModel?.();
        if (choice.plain || !choice.mounted || !model) return;
        monacoRef.current?.editor?.setModelMarkers?.(model, 'code-safety', markers);
    }, [markers, choice.plain, choice.mounted]);

    useEffect(() => {
        if (!handleRef) return;
        handleRef.current = {
            revealLine: (line, column = 1) => {
                const ed = editorRef.current;
                if (!choice.plain && ed?.revealLineInCenter) {
                    ed.revealLineInCenter(line);
                    ed.setPosition?.({ lineNumber: line, column });
                    ed.focus?.();
                    return;
                }
                const ta = textareaRef.current;
                if (!ta) return;
                const { start, end } = lineRange(ta.value, line);
                ta.focus();
                ta.setSelectionRange(start, end);
            },
        };
    }, [handleRef, choice.plain]);

    const onMount = (editor: unknown, monaco: unknown) => {
        if (!editor) { choice.setFailure(prev => prev || 'stalled'); return; }
        editorRef.current = editor as EditorLike;
        monacoRef.current = monaco as MonacoLike;
        choice.setMounted(true);
    };
    const label = t('code_step.editor.aria', 'JavaScript code');

    return (
        <div className={fill ? 'flex flex-col min-h-0 h-full gap-1.5' : 'space-y-1.5'}>
            <SegmentedControl
                size="sm"
                value={choice.plain ? 'plain' : 'rich'}
                onChange={choice.choose}
                disabled={choice.failure === 'chunk'}
                ariaLabel={t('code_step.editor.how', 'How to edit this code')}
                options={[
                    { value: 'rich', label: t('code_step.editor.rich', 'Code editor') },
                    { value: 'plain', label: t('code_step.editor.plain', 'Plain text') },
                ]}
            />
            <FailureNote failure={choice.failure} />
            {choice.plain ? (
                <textarea
                    ref={textareaRef}
                    rows={fill ? undefined : 14}
                    aria-label={label}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    className={`${textareaClass()} font-mono ${fill ? 'flex-1 min-h-0 resize-none' : ''}`}
                    spellCheck={false}
                />
            ) : (
                <div className={`rounded-md border border-[var(--border-default)] overflow-hidden ${fill ? 'flex-1 min-h-0' : ''}`}>
                    <Suspense fallback={<div className={`${hintTextClass()} p-3`}>{t('code_step.editor.loading', 'Loading the code editor…')}</div>}>
                        <MonacoEditor
                            height={fill ? '100%' : '280px'}
                            language="javascript"
                            value={value}
                            onChange={(v) => onChange(v ?? '')}
                            onMount={onMount}
                            onUnavailable={choice.onUnavailable}
                            theme={monacoTheme()}
                            options={monacoOptions(label)}
                        />
                    </Suspense>
                </div>
            )}
            {!choice.plain && (
                <p className={hintTextClass()}>
                    {t('code_step.editor.keyboard', 'Keyboard: Tab indents inside the code editor. Press Ctrl+M (⌘M on macOS) first to make Tab move focus out again, or switch to Plain text above, which never holds on to Tab.')}
                </p>
            )}
        </div>
    );
}

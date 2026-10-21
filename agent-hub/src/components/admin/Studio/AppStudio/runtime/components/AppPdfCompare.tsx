import { FileText, Loader2, RotateCw } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { useDataContext } from '../DataContext';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { HEIGHT_PX, isFill, resolveHeightCss } from '../styleResolver';
import { EmptyText } from '../uiBits';
import type { NodeProps } from './appNode.types';
import { firstDescriptor } from './fileLoading';
import CompareView from './pdfCompare/CompareView';
import { useFileBlob, usePdfDocument } from './pdfCompare/hooks';
import type { Mode } from './pdfCompare/Toolbar';

/**
 * App Studio runtime — 'pdf_compare'. Spec: server/appStudio/componentSpecs/contentSpecs.js.
 *
 * Two PDFs with the same page geometry (an original and its changed copy),
 * rendered with pdf.js instead of the browser's own viewer: fit-to-width by
 * default, synced pages/zoom/scroll, and the changed regions marked with red
 * boxes. The boxes come from a pixel diff of both pages at the same scale, so
 * they show exactly what a redaction removed.
 *
 * This file owns loading and the status screens; ./pdfCompare/CompareView owns
 * everything once the documents are open. Loading goes through the same
 * authFetch → blob path as file_preview (./fileLoading). The pdf.js engine is
 * lazy (./pdfCompare/pdfEngine) and the headless screenshot bundle swaps it for
 * a stub: this component then shows its placeholder instead of throwing.
 */

const MODES: Mode[] = ['side', 'swipe', 'diff'];
const CENTERED = 'flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-[var(--text-secondary)]';
const SHELL_STYLE: CSSProperties = { borderRadius: 'var(--app-radius, inherit)' };

interface Props { left?: unknown; right?: unknown; leftLabel?: string; rightLabel?: string; emptyText?: string; mode?: string; allowDownload?: boolean }

function Message({ icon, children, retry }: { icon?: ReactNode; children: ReactNode; retry?: { label: string; onClick: () => void } }) {
    return (
        <div className={CENTERED}>
            {icon}
            <span>{children}</span>
            {retry ? (
                <button type="button" onClick={retry.onClick} className="inline-flex items-center gap-1.5 rounded border border-[var(--border-default)] px-2.5 py-1.5 text-xs">
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />{retry.label}
                </button>
            ) : null}
        </div>
    );
}

const FileIcon = () => <FileText className="h-6 w-6 text-[var(--text-muted)]" aria-hidden="true" />;

export default function AppPdfCompare({ node }: NodeProps<Props>) {
    const { t } = useTranslation();
    const { mode: runtimeMode, actionState, dataState, scope } = useRuntime();
    const { appId } = useDataContext();
    const props = node.props || {};
    const leftLabel = props.leftLabel || t('studio_apps_runtime.pdf_compare.original', 'Original');
    const rightLabel = props.rightLabel || t('studio_apps_runtime.pdf_compare.cleaned', 'Cleaned');
    const emptyText = props.emptyText || t('studio_apps_runtime.pdf_compare.empty', 'No documents to compare.');

    const ctx = { actionState, dataState, scope } as never;
    const leftDesc = firstDescriptor(resolveBinding(props.left as never, ctx).value);
    const rightDesc = firstDescriptor(resolveBinding(props.right as never, ctx).value);

    // Editing must never fetch (the canvas re-renders on every keystroke).
    const live = runtimeMode === 'run' && !!appId;
    const [attempt, setAttempt] = useState(0);
    const [renderError, setRenderError] = useState<string | null>(null);
    const leftFile = useFileBlob(leftDesc, live, appId || undefined, attempt);
    const rightFile = useFileBlob(rightDesc, live, appId || undefined, attempt);
    const leftDoc = usePdfDocument(leftFile.blob);
    const rightDoc = usePdfDocument(rightFile.blob);

    const fill = isFill(node as never);
    const style = node?.style as { height?: string } | undefined;
    const boxed = fill || Boolean(resolveHeightCss(style as never)) || Boolean(HEIGHT_PX[style?.height || '']);
    const shell = (children: ReactNode, status: string) => (
        <div
            className={`flex w-full min-w-0 flex-col overflow-hidden border border-[var(--border-default)] bg-[var(--bg-primary)]${fill ? ' app-fill' : ''}${boxed ? ' h-full min-h-0' : ' h-[36rem]'}`}
            style={SHELL_STYLE}
            data-app-pdfcompare={status}
        >
            {children}
        </div>
    );

    if (!leftDesc && !rightDesc) return shell(<EmptyText text={emptyText} />, 'empty');
    if (!live) return shell(<Message icon={<FileIcon />}>{leftLabel} / {rightLabel}</Message>, 'design');

    const sides = [{ desc: leftDesc, file: leftFile, doc: leftDoc }, { desc: rightDesc, file: rightFile, doc: rightDoc }].filter((s) => s.desc);
    const failed = sides.find((s) => s.file.status === 'error');
    if (failed) {
        return shell(<Message retry={{ label: t('studio_apps_runtime.pdf_compare.try_again', 'Try again'), onClick: () => setAttempt((n) => n + 1) }}>{failed.file.error}</Message>, 'error');
    }
    if (renderError || sides.some((s) => s.doc.status === 'error')) {
        return shell(<Message icon={<FileIcon />}>{t('studio_apps_runtime.pdf_compare.unavailable', 'The PDF preview is not available here.')}</Message>, 'unavailable');
    }
    if (sides.some((s) => s.doc.status !== 'ready')) {
        return shell(
            <Message icon={<Loader2 className="h-5 w-5 animate-spin text-[var(--text-muted)]" aria-hidden="true" />}>
                {t('studio_apps_runtime.pdf_compare.loading', 'Loading documents…')}
            </Message>, 'loading');
    }

    const downloads = props.allowDownload === false ? null : [
        { url: leftFile.url, name: leftFile.name, label: leftLabel },
        { url: rightFile.url, name: rightFile.name, label: rightLabel },
    ];
    return shell(
        <CompareView
            left={leftDoc.doc} right={rightDoc.doc} leftLabel={leftLabel} rightLabel={rightLabel} emptyText={emptyText}
            initialMode={MODES.includes(props.mode as Mode) ? (props.mode as Mode) : 'side'}
            downloads={downloads} onError={setRenderError}
        />,
        'ready',
    );
}

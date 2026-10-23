import { Download, FileText, Loader2, RotateCw } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState, type JSX } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { authFetch } from '../../../../../../utils/helpers';
import { useDataContext } from '../DataContext';
import { hoverable } from '../hoverable';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { HEIGHT_PX, isFill, resolveHeightCss } from '../styleResolver';
import { EmptyText } from '../uiBits';
import { entryHref, entryName } from './AppInputFile';
import { descriptorKey, firstDescriptor, friendlyError, materializeEntry, type FileEntry } from './fileLoading';
import type { BindingInput } from '../resolveBinding.types';
import type { NodeProps } from './appNode.types';

export { firstDescriptor };

/**
 * App Studio runtime — 'file_preview'. Spec: server/appStudio/componentSpecs.js.
 *
 * Named for FILES, not PDFs: a `file` column holds whatever arrived, and a
 * component that only handled PDFs would leave images and documents as a dead
 * end in the one place people look for them.
 *
 * WHY A BLOB URL AND NOT `<iframe src={API_BASE}/…>`, which would be simpler:
 *   • authFetch is the demo-mode choke point (utils/helpers setDemoTransport).
 *     A raw iframe src bypasses it entirely and turns an anonymous demo click
 *     into a real authenticated API call.
 *   • In the Nextcloud embedding API_BASE is a different origin behind the
 *     AppAPI proxy, where `frame-src 'self'` blocks it — and third-party cookie
 *     blocking would break the session anyway.
 * The same-origin blob is already CSP-legal in production (`frame-src blob:`,
 * added for the invoice viewer) and needs no nginx change.
 *
 * A mailbox attachment arrives as a PENDING descriptor pointing at the provider.
 * The first view redeems it (POST …/attachments/materialize) and it becomes an
 * ordinary stored file; every later view short-circuits server-side.
 */

const PREVIEWABLE_IMAGE = /^image\/(png|jpeg|gif|webp)$/i;

/**
 * CAD files the server can DRAW. A .step is bytes describing surfaces and a
 * .dxf is a list of curves; neither has a preview of its own, but the server
 * renders both to a PNG — four shaded views for a solid, one flat drawing for
 * a DXF. So the only thing this component needs to know is which files to ask
 * for the rendered version instead of the raw one.
 *
 * Matched on name as well as MIME because a mailed .step routinely arrives as
 * application/octet-stream, which is exactly the file the user is looking at
 * when they wonder why there is no picture.
 */
const CAD_MIME = /^(model\/(step|iges)|image\/vnd\.dxf)$/i;
const CAD_EXT = /\.(step|stp|p21|iges|igs|dxf)$/i;
function wantsCadRender(entry: FileEntry, mime: string) {
    if (CAD_MIME.test(mime || '')) return true;
    return CAD_EXT.test(entryName(entry) || '');
}

const CENTERED = 'flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center';
const SMALL_BUTTON = 'inline-flex items-center gap-1.5 border px-2.5 py-1.5 text-xs';
const BUTTON_STYLE = { borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-secondary)' };

/** Editing shows the shape without spending a request. */
interface DesignPlaceholderProps {
    name: string;
}

function DesignPlaceholder({ name }: DesignPlaceholderProps) {
    return (
        <div className={`${CENTERED} gap-2`} style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
            <FileText className="h-6 w-6" aria-hidden="true" />
            <span className="text-xs">{name}</span>
        </div>
    );
}

function Spinner() {
    return (
        <div className="flex h-full w-full items-center justify-center p-6 text-[var(--text-muted)]">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        </div>
    );
}

interface ErrorStateProps {
    message: string;
    onRetry: () => void;
}

function ErrorState({ message, onRetry }: ErrorStateProps) {
    const { t } = useTranslation();
    return (
        <div className={CENTERED}>
            <span className="text-sm text-[var(--text-secondary)]">{message}</span>
            <button type="button" onClick={onRetry} className={SMALL_BUTTON} style={BUTTON_STYLE}>
                <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                {t('studio_apps_runtime.file_preview.try_again', 'Try again')}
            </button>
        </div>
    );
}

/**
 * The fallback for every type we will not render inline. Framing foreign HTML
 * or SVG on our own origin would make the app a phishing host, so unknown types
 * are downloads and nothing else.
 */
interface DownloadCardProps {
    name: string;
    url: string;
    allowDownload: boolean;
}

function DownloadCard({ name, url, allowDownload }: DownloadCardProps) {
    const { t } = useTranslation();
    return (
        <div className={CENTERED}>
            <FileText className="h-6 w-6 text-[var(--text-muted)]" aria-hidden="true" />
            <span className="text-sm text-[var(--text-secondary)]">{name}</span>
            {allowDownload ? (
                <a href={url} download={name} className={SMALL_BUTTON} style={BUTTON_STYLE}>
                    <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('studio_apps_runtime.file_preview.download', 'Download')}
                </a>
            ) : null}
        </div>
    );
}

interface FilePreviewProps {
    source?: BindingInput;
    emptyText?: string;
    allowDownload?: boolean;
}

/** What the preview is showing right now. */
interface PreviewState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    url: string | null;
    downloadUrl?: string | null;
    mime: string | null;
    name: string | null;
    error: string | null;
    rendered?: boolean;
}

export default function AppFilePreview({ node }: NodeProps<FilePreviewProps>) {
    const { t } = useTranslation();
    const { mode, actionState, dataState, scope } = useRuntime();
    const { appId } = useDataContext();
    const { emptyText = t('studio_apps_runtime.file_preview.empty', 'No document selected.'), allowDownload = true } = node.props || {};
    const { value } = resolveBinding(node.props?.source, { actionState, dataState, scope });

    const descriptor = firstDescriptor(value);
    const [state, setState] = useState<PreviewState>({ status: 'idle', url: null, mime: null, name: null, error: null });
    const [attempt, setAttempt] = useState(0);
    const urlRef = useRef<string | null>(null);
    // Read inside the load effect without making the effect re-run when the catalogue loads.
    const tRef = useRef(t);
    tRef.current = t;
    // A rendered CAD file holds TWO blobs: the picture on screen and the
    // source file behind Download. Both have to be released on unmount.
    const sourceRef = useRef<string | null>(null);

    // The identity of the file being shown — a plain string so the effect does
    // not re-run on every render just because the descriptor object is new.
    const key = descriptorKey(descriptor);

    // Editing must never fetch. The canvas re-renders on every keystroke, and a
    // fetch here would hammer the read limiter and, in a demo, leak real calls.
    const live = mode === 'run' && !!appId;

    // The descriptor object is new every render; `key` names the file, and
    // the fetch reads the current object through an Effect Event.
    const currentDescriptor = useEffectEvent(() => descriptor);
    useEffect(() => {
        if (!live || !key) { setState({ status: 'idle', url: null, mime: null, name: null, error: null }); return undefined; }

        let alive = true;
        const revoke = () => {
            if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null; }
            if (sourceRef.current) { URL.revokeObjectURL(sourceRef.current); sourceRef.current = null; }
        };

        (async () => {
            revoke();
            setState({ status: 'loading', url: null, mime: null, name: null, error: null });
            try {
                let entry = currentDescriptor();

                // A pending mailbox pointer has no bytes of its own yet.
                entry = await materializeEntry(entry, appId);

                const href = entryHref(entry, appId);
                if (!href) throw Object.assign(new Error('That file cannot be opened.'), { status: 415 });

                // A 3D file is asked for as a picture. If the kernel cannot draw
                // it the server says 415 and we fall back to the raw file, which
                // still gives the person a download card — never a dead screen
                // because a preview failed.
                // A 3D file is asked for as a picture first. If the kernel
                // cannot draw it the server answers 415 and we fall through to
                // the raw file, which still gives a download card — a preview
                // that fails must never leave a blank screen behind.
                let rendered = false;
                let res: Response | null = null;
                if (wantsCadRender(entry, (entry && typeof entry === 'object' && entry.mime) || '')) {
                    const shot = await authFetch(`${href}/preview`);
                    if (shot.ok) { res = shot; rendered = true; }
                }
                if (!res) {
                    res = await authFetch(href);
                    if (!res.ok) throw Object.assign(new Error(''), { status: res.status });
                }
                const blob = await res.blob();
                if (!alive) return;

                const url = URL.createObjectURL(blob);
                urlRef.current = url;

                // What is SHOWN and what is SAVED are different things for a
                // rendered file: nobody wants a PNG of the part they have to
                // cut. Fetch the source too so Download still hands over the
                // .step — these files are a few hundred kB, and the alternative
                // is a link that silently gives you the wrong thing.
                let downloadUrl = url;
                if (rendered) {
                    try {
                        const src = await authFetch(href);
                        if (src.ok && alive) {
                            downloadUrl = URL.createObjectURL(await src.blob());
                            sourceRef.current = downloadUrl;
                        }
                    } catch { /* the picture is still worth showing */ }
                }

                setState({
                    status: 'ready',
                    url,
                    downloadUrl,
                    mime: rendered ? 'image/png' : ((entry && typeof entry === 'object' && entry.mime) || blob.type || 'application/octet-stream'),
                    name: entryName(entry),
                    rendered,
                    error: null,
                });
            } catch (err) {
                if (!alive) return;
                setState({ status: 'error', url: null, mime: null, name: null, error: friendlyError((err as { status?: number }).status, (err as Error).message, tRef.current) });
            }
        })();

        return () => { alive = false; revoke(); };
    }, [live, key, attempt, appId]);

    const fill = isFill(node);
    // A cell that already has a height (a preset such as 'xl', or an explicit
    // heightMode) is a box to fill as much as 'fill' is. Without this the frame
    // fell back to its 20rem minimum and a PDF sat at 320px inside a 620px cell.
    const boxed = fill || Boolean(resolveHeightCss(node?.style)) || Boolean(HEIGHT_PX[node?.style?.height ?? '']);
    const shell = (children: JSX.Element) => (
        <div
            className={`w-full min-w-0 overflow-hidden${fill ? ' app-fill' : ''}${boxed ? ' flex flex-col h-full min-h-0' : ''}`}
            style={{ borderRadius: 'inherit', ...(boxed ? null : { minHeight: '24rem' }) }}
            data-app-filepreview={state.status}
        >
            {children}
        </div>
    );

    if (!descriptor) return shell(<EmptyText text={emptyText} />);

    if (!live) return shell(<DesignPlaceholder name={entryName(descriptor)} />);
    if (state.status === 'loading' || state.status === 'idle') return shell(<Spinner />);
    if (state.status === 'error') return shell(<ErrorState message={state.error ?? ''} onRetry={() => setAttempt((n) => n + 1)} />);

    const isPdf = state.mime === 'application/pdf';
    const isImage = PREVIEWABLE_IMAGE.test(state.mime || '');

    // Anything we cannot vouch for renders as a link, never inline. Foreign HTML
    // or SVG in an iframe on our own origin is a phishing host waiting to happen.
    // Anything we cannot vouch for is a link, never inline.
    if (!isPdf && !isImage) {
        return shell(<DownloadCard name={state.name ?? ''} url={state.url ?? ''} allowDownload={allowDownload} />);
    }

    return shell(
        <>
            {allowDownload ? (
                <div className="flex shrink-0 items-center justify-between gap-2 px-2 py-1.5">
                    <span className="truncate text-xs text-[var(--text-secondary)]" {...hoverable(state.name)}>{state.name}</span>
                    <a
                        href={(state.downloadUrl || state.url) ?? undefined}
                        download={state.name}
                        aria-label={t('studio_apps_runtime.file_preview.download_name', 'Download {name}', { name: state.name })}
                        className="inline-flex shrink-0 items-center gap-1 text-xs text-[var(--text-muted)]"
                    >
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                </div>
            ) : null}
            {isPdf ? (
                <iframe
                    title={state.name || t('studio_apps_runtime.file_preview.document', 'Document')}
                    src={state.url ?? undefined}
                    className={`w-full border-0${boxed ? ' flex-1 min-h-0' : ' h-full min-h-[20rem]'}`}
                />
            ) : (
                <img
                    src={state.url ?? undefined}
                    alt={state.name || ''}
                    className={`w-full${boxed ? ' flex-1 min-h-0' : ' h-full'}`}
                    style={{ objectFit: 'contain' }}
                />
            )}
        </>,
    );
}

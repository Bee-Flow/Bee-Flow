import { AlertTriangle, RotateCcw, X } from 'lucide-react';
import { friendlyBuilderError } from './builderPaneModel';
import useTranslation from '../../../../../hooks/useTranslation';

/** A picture in the transcript (`{ kind:'image' }`). */
export interface TranscriptImage {
    dataUrl?: string;
    caption?: string;
    fromUser?: boolean;
}

/** A screenshot staged in the composer, waiting for send. */
export interface StagedImage {
    id: string;
    name: string;
    dataUrl: string;
}

/**
 * A picture in the transcript: one the AI took of the draft (SSE `image`
 * event) — kept so the user sees exactly what the AI judged, vision model or
 * not — or one the user attached (`fromUser`), which sits narrower and to the
 * right so the transcript still reads as a conversation.
 */
export function ScreenshotItem({ item }: { item: TranscriptImage }) {
    const { t } = useTranslation();
    const fromUser = !!item.fromUser;
    return (
        <figure
            className={`overflow-hidden rounded-lg border ${fromUser ? 'max-w-[70%] self-end' : 'w-full'}`}
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}
        >
            <img
                src={item.dataUrl}
                alt={item.caption || (fromUser ? t('studio_apps_edit.chat.image_attached', 'Image you attached') : t('studio_apps_edit.chat.screenshot_alt', 'Screenshot of the app'))}
                className="block w-full"
            />
            {item.caption ? (
                <figcaption className="px-2.5 py-1.5 text-[11px] text-[var(--text-tertiary)]">
                    {item.caption}
                </figcaption>
            ) : null}
        </figure>
    );
}

/**
 * The composer's staged-image strip: a thumbnail per attached screenshot with
 * its own remove button. Cleared by the composer the moment the turn is sent.
 */
export function StagedImages({ images, onRemove, disabled = false }: { images: StagedImage[]; onRemove: (id: string) => void; disabled?: boolean }) {
    const { t } = useTranslation();
    if (!images.length) return null;
    return (
        <ul className="flex flex-wrap gap-1.5" data-staged-images="">
            {images.map((img) => (
                <li key={img.id} className="relative">
                    <img
                        src={img.dataUrl}
                        alt={img.name}
                        title={img.name}
                        className="h-14 w-14 rounded border object-cover [border-color:var(--border-default)]"
                    />
                    <button
                        type="button"
                        onClick={() => onRemove(img.id)}
                        disabled={disabled}
                        aria-label={t('studio_apps_edit.chat.remove_image', 'Remove {name}', { name: img.name })}
                        className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border shadow-sm transition-opacity disabled:opacity-40 [border-color:var(--border-default)] [background:var(--bg-primary)] [color:var(--text-secondary)]"
                    >
                        <X size={10} aria-hidden="true" />
                    </button>
                </li>
            ))}
        </ul>
    );
}

interface ErrorItemProps {
    message?: string;
    code?: string | null;
    onRetry: (() => void) | null;
    disabled?: boolean;
}

/**
 * A failed turn — the toast is transient, this stays in the transcript. Maps
 * the server's error-taxonomy `code` (Wave 6c) to friendly copy and, for the
 * retryable codes, a "Try again" button that re-runs the last turn.
 */
export function ErrorItem({ message, code, onRetry, disabled = false }: ErrorItemProps) {
    const { t } = useTranslation();
    const { message: friendly, canRetry } = friendlyBuilderError(code, message, t);
    const showRetry = canRetry && typeof onRetry === 'function';
    return (
        <div
            className="flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-xs leading-relaxed [border-color:rgba(239,68,68,0.35)] [background:color-mix(in_srgb,var(--error)_8%,transparent)] [color:var(--text-secondary)]!"
            role="alert"
        >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--error)' }} aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span>{friendly}</span>
                {showRetry ? (
                    <button
                        type="button"
                        onClick={() => onRetry()}
                        disabled={disabled}
                        className="inline-flex w-fit items-center gap-1 rounded border px-1.5 py-0.5 font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40 [border-color:color-mix(in_srgb,var(--error)_40%,transparent)] [color:var(--text-secondary)]"
                    >
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        {t('app_studio.builder.chat.try_again', 'Try again')}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Bold, Code, Heading2, Heading3, Image as ImageIcon, Italic, Link2, List, ListOrdered, Minus, Quote, Upload } from 'lucide-react';
import { AssetPickerDialog } from './jsComponents';
import { uploadCmsFile } from '../cmsUpload';
import { useTranslation } from '../../../../hooks/useTranslation';
import {
    imageMarkdown, insertBlock, insertLink, toggleLinePrefix, wordCount, wrapSelection, type TextState,
} from './markdownCommands';

/**
 * The post body editor: a Markdown textarea with a formatting toolbar,
 * keyboard shortcuts (Ctrl/Cmd+B, I, K) and image insertion from the media
 * library or a fresh upload. The live preview is the canvas next to it —
 * the real public renderer — so this stays a fast plain-text surface.
 */

interface Props {
    value: string;
    onChange: (next: string) => void;
    maxLength: number;
    ariaLabel: string;
    placeholder?: string;
    /** Translation mode: images and structure come from the original post. */
    textOnly?: boolean;
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            title={label}
            aria-label={label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            className="p-1.5 rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent-primary)]"
        >
            {children}
        </button>
    );
}

type Command = (s: TextState) => TextState;

function Toolbar({ apply, textOnly, onLibrary, onUpload }: { apply: (fn: Command) => void; textOnly: boolean; onLibrary: () => void; onUpload: () => void }) {
    const { t } = useTranslation();
    const bold = t('cms_blog.editor.bold_text', 'bold text');
    const italic = t('cms_blog.editor.italic_text', 'italic text');
    const linkText = t('cms_blog.editor.link_text', 'link text');
    const tools: { label: string; icon: ReactNode; run: Command }[] = [
        { label: t('cms_blog.editor.heading2', 'Section heading'), icon: <Heading2 className="w-4 h-4" />, run: s => toggleLinePrefix(s, '## ') },
        { label: t('cms_blog.editor.heading3', 'Sub-heading'), icon: <Heading3 className="w-4 h-4" />, run: s => toggleLinePrefix(s, '### ') },
        { label: t('cms_blog.editor.bold', 'Bold (Ctrl+B)'), icon: <Bold className="w-4 h-4" />, run: s => wrapSelection(s, '**', '**', bold) },
        { label: t('cms_blog.editor.italic', 'Italic (Ctrl+I)'), icon: <Italic className="w-4 h-4" />, run: s => wrapSelection(s, '_', '_', italic) },
        { label: t('cms_blog.editor.link', 'Link (Ctrl+K)'), icon: <Link2 className="w-4 h-4" />, run: s => insertLink(s, 'https://', linkText) },
        { label: t('cms_blog.editor.bullets', 'Bulleted list'), icon: <List className="w-4 h-4" />, run: s => toggleLinePrefix(s, '- ') },
        { label: t('cms_blog.editor.numbers', 'Numbered list'), icon: <ListOrdered className="w-4 h-4" />, run: s => toggleLinePrefix(s, '', { numbered: true }) },
        { label: t('cms_blog.editor.quote', 'Quote'), icon: <Quote className="w-4 h-4" />, run: s => toggleLinePrefix(s, '> ') },
        { label: t('cms_blog.editor.code', 'Code'), icon: <Code className="w-4 h-4" />, run: s => wrapSelection(s, '`', '`', 'code') },
        { label: t('cms_blog.editor.rule', 'Divider'), icon: <Minus className="w-4 h-4" />, run: s => insertBlock(s, '---') },
    ];
    return (
        <div className="flex flex-wrap items-center gap-0.5 px-1 py-1 border-b border-[var(--border-subtle)]" role="toolbar" aria-label={t('cms_blog.editor.toolbar', 'Formatting')}>
            {tools.map(tool => <ToolButton key={tool.label} label={tool.label} onClick={() => apply(tool.run)}>{tool.icon}</ToolButton>)}
            {!textOnly ? (
                <>
                    <span className="mx-1 h-4 w-px bg-[var(--border-default)]" aria-hidden="true" />
                    <ToolButton label={t('cms_blog.editor.image_library', 'Image from the media library')} onClick={onLibrary}><ImageIcon className="w-4 h-4" /></ToolButton>
                    <ToolButton label={t('cms_blog.editor.image_upload', 'Upload an image')} onClick={onUpload}><Upload className="w-4 h-4" /></ToolButton>
                </>
            ) : null}
        </div>
    );
}

function StatusBar({ value, uploading, uploadError }: { value: string; uploading: number | null; uploadError: string | null }) {
    const { t } = useTranslation();
    const words = wordCount(value);
    const minutes = words ? Math.max(1, Math.round(words / 220)) : 0;
    return (
        <div className="flex items-center gap-2 px-3 py-1 border-t border-[var(--border-subtle)] text-[10px] text-[var(--text-muted)]">
            <span>{t('cms_blog.editor.words', '{n} words · {m} min read', { n: words, m: minutes })}</span>
            {uploading !== null ? <span>{t('cms_blog.editor.uploading', 'Uploading… {p}%', { p: uploading })}</span> : null}
            {uploadError ? <span className="text-red-400">{uploadError}</span> : null}
            <span className="ml-auto">{t('cms_blog.editor.markdown_hint', 'Markdown · HTML is shown as text')}</span>
        </div>
    );
}

/** Upload one image to the CMS and hand its asset URL on; progress and error for the status bar. */
function useImageUpload(onDone: (url: string) => void) {
    const [uploading, setUploading] = useState<number | null>(null);
    const [uploadError, setUploadError] = useState<string | null>(null);
    const upload = async (file: File | undefined, input: HTMLInputElement) => {
        if (!file) return;
        setUploadError(null);
        setUploading(0);
        try {
            const res = await uploadCmsFile(file, { onProgress: (p) => setUploading(p) });
            onDone(res.url);
        } catch (err) {
            setUploadError(err instanceof Error ? err.message : String(err));
        } finally {
            setUploading(null);
            input.value = '';
        }
    };
    return { uploading, uploadError, upload };
}

export default function MarkdownEditor({ value, onChange, maxLength, ariaLabel, placeholder, textOnly = false }: Props) {
    const { t } = useTranslation();
    const ref = useRef<HTMLTextAreaElement | null>(null);
    const fileRef = useRef<HTMLInputElement | null>(null);
    const [picking, setPicking] = useState(false);

    const state = (): TextState => {
        const el = ref.current;
        return { value, start: el?.selectionStart ?? value.length, end: el?.selectionEnd ?? value.length };
    };
    const apply = (next: TextState) => {
        onChange(next.value.slice(0, maxLength));
        requestAnimationFrame(() => {
            const el = ref.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(next.start, next.end);
        });
    };
    const insertImage = (url: string) => apply(insertBlock(state(), imageMarkdown(url, t('cms_blog.editor.image_alt_placeholder', 'Describe the image'))));

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const k = e.key.toLowerCase();
        if (k === 'b') { e.preventDefault(); apply(wrapSelection(state(), '**', '**', t('cms_blog.editor.bold_text', 'bold text'))); }
        else if (k === 'i') { e.preventDefault(); apply(wrapSelection(state(), '_', '_', t('cms_blog.editor.italic_text', 'italic text'))); }
        else if (k === 'k') { e.preventDefault(); apply(insertLink(state(), 'https://', t('cms_blog.editor.link_text', 'link text'))); }
    };

    const { uploading, uploadError, upload } = useImageUpload(insertImage);

    return (
        <div className="rounded-md border border-[var(--border-default)] bg-[var(--bg-tertiary)] focus-within:border-[var(--accent-primary)]">
            <Toolbar
                apply={(fn) => apply(fn(state()))}
                textOnly={textOnly}
                onLibrary={() => setPicking(true)}
                onUpload={() => fileRef.current?.click()}
            />
            {!textOnly ? (
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                    className="hidden"
                    onChange={(e) => { void upload(e.target.files?.[0], e.target); }}
                />
            ) : null}
            <textarea
                ref={ref}
                value={value}
                onChange={(e) => onChange(e.target.value.slice(0, maxLength))}
                onKeyDown={onKeyDown}
                aria-label={ariaLabel}
                placeholder={placeholder}
                spellCheck
                className="block w-full min-h-[320px] max-h-[60vh] resize-y px-3 py-2 bg-transparent text-[13px] leading-relaxed font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
            />
            <StatusBar value={value} uploading={uploading} uploadError={uploadError} />
            {picking ? (
                <AssetPickerDialog
                    accept="image"
                    onClose={() => setPicking(false)}
                    onPick={(url: string) => { setPicking(false); insertImage(url); }}
                />
            ) : null}
        </div>
    );
}

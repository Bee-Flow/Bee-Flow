import { SLOT_LANGUAGE } from '../webpageCodeFiles';
import { isPrimaryFile, type ContentSetter, type ExtraContents, type ExtraFileMeta, type PrimaryContent } from '../webpageEditorTypes';

/**
 * An editor tab key: a primary slot ('html' | 'css' | 'js') or
 * 'extra:<path>' for an extra file.
 */
export type FileKey = string;

const EXTRA_PREFIX = 'extra:';

const LANGUAGE_BY_EXT: Record<string, string> = {
    html: 'html', htm: 'html',
    css: 'css',
    js: 'javascript', mjs: 'javascript',
    json: 'json',
    md: 'markdown', markdown: 'markdown',
    svg: 'xml', xml: 'xml',
    ts: 'typescript', tsx: 'typescript',
    yml: 'yaml', yaml: 'yaml',
};

/**
 * Map common file extensions to Monaco language ids. Anything unrecognised
 * renders as plain text — still editable, just no syntax highlighting.
 */
export function pickLanguage(path: string): string {
    const ext = (path.split('.').pop() || '').toLowerCase();
    return Object.hasOwn(LANGUAGE_BY_EXT, ext) ? LANGUAGE_BY_EXT[ext] : 'plaintext';
}

/** What the editor pane renders for the active tab. */
export type ActiveView =
    | { kind: 'text'; value: string; language: string; onChange: ContentSetter }
    | { kind: 'missing'; path: string }
    | { kind: 'binary'; path: string; mimeType?: string; dataUrl?: string; size: number };

export interface ActiveViewInputs {
    content: PrimaryContent;
    extraFiles: ExtraFileMeta[];
    extraContents: ExtraContents;
    onPrimaryChange: Record<'html' | 'css' | 'js', ContentSetter | undefined>;
    onExtraChange?: (path: string, value: string) => void;
}

/** Resolve the active tab key to what the editor pane should render. */
export function resolveActiveView(activeKey: FileKey | null, inputs: ActiveViewInputs): ActiveView | null {
    if (!activeKey) return null;
    if (isPrimaryFile(activeKey)) {
        const onChange = inputs.onPrimaryChange[activeKey];
        return {
            kind: 'text',
            value: inputs.content[activeKey] || '',
            language: SLOT_LANGUAGE[activeKey],
            onChange: (v) => { onChange?.(v); },
        };
    }
    if (!activeKey.startsWith(EXTRA_PREFIX)) return null;
    const path = activeKey.slice(EXTRA_PREFIX.length);
    const meta = inputs.extraFiles.find(f => f.path === path);
    const content = inputs.extraContents[path];
    if (!content) return { kind: 'missing', path };
    if (content.isText) {
        return {
            kind: 'text',
            value: content.content || '',
            language: pickLanguage(path),
            onChange: (v) => inputs.onExtraChange?.(path, v),
        };
    }
    return { kind: 'binary', path, mimeType: meta?.mimeType || content.mimeType, dataUrl: content.dataUrl, size: meta?.size || 0 };
}

/**
 * Status-bar activeFile token — kept compatible with the StatusBar contract
 * that distinguishes primary slots (string) from extras ({kind:'extra'}).
 */
export function statusActiveFile(activeKey: FileKey | null): string | { kind: 'extra'; path: string } | null {
    if (!activeKey) return null;
    if (isPrimaryFile(activeKey)) return activeKey;
    if (activeKey.startsWith(EXTRA_PREFIX)) return { kind: 'extra', path: activeKey.slice(EXTRA_PREFIX.length) };
    return null;
}

/** FileExplorer's activeFile prop is in the old shape ('html'|'css'|'js' or {path}). */
export function explorerActiveFile(activeKey: FileKey | null): string | { path: string } | null {
    if (!activeKey) return null;
    if (isPrimaryFile(activeKey)) return activeKey;
    if (activeKey.startsWith(EXTRA_PREFIX)) return { path: activeKey.slice(EXTRA_PREFIX.length) };
    return null;
}

/** The tab key for what the explorer selected. */
export function keyForExplorerSelection(file: unknown): FileKey | null {
    if (typeof file === 'string') return file;
    const path = (file as { path?: string } | null)?.path;
    return path ? `${EXTRA_PREFIX}${path}` : null;
}

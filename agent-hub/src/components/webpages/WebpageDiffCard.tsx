import React, { useState } from 'react';
import { ChevronRight, FileCode2, Palette, Cpu } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface DiffHunk {
    type: string;
    text: string;
}

interface WebpageDiff {
    summary: string;
    added: number;
    removed: number;
    hunks?: DiffHunk[];
}

interface WebpageDiffCardProps {
    file: string;
    diff?: WebpageDiff | null;
}

const FILE_META: Record<string, { label: string; Icon: LucideIcon }> = {
    html: { label: 'index.html', Icon: FileCode2 },
    css:  { label: 'style.css',  Icon: Palette },
    js:   { label: 'script.js',  Icon: Cpu },
};

function summaryBackground(diff: { added: number; removed: number }): string {
    if (diff.added > 0 && diff.removed === 0) return 'rgba(22,163,74,0.85)';
    if (diff.removed > 0 && diff.added === 0) return 'rgba(220,38,38,0.85)';
    return 'rgba(2,132,199,0.85)';
}

const HUNK_LOOK: Record<string, { sigil: string; bg: string; fg: string }> = {
    add: { sigil: '+', bg: 'rgba(22,163,74,0.12)', fg: 'rgb(22,101,52)' },
    remove: { sigil: '-', bg: 'rgba(220,38,38,0.12)', fg: 'rgb(153,27,27)' },
    gap: { sigil: ' ', bg: 'transparent', fg: 'var(--vsc-fg-muted, var(--text-tertiary))' },
};
const HUNK_LOOK_DEFAULT = { sigil: ' ', bg: 'transparent', fg: 'var(--vsc-fg, var(--text-primary))' };

function hunkLook(type: string): { sigil: string; bg: string; fg: string } {
    return Object.hasOwn(HUNK_LOOK, type) ? HUNK_LOOK[type] : HUNK_LOOK_DEFAULT;
}

/**
 * Compact post-edit diff card rendered below an assistant message in the
 * Webpages chat. Shows filename, +X −Y summary, and an expandable list of
 * hunks. Purely informational — the change is already applied to the editor.
 */
export default function WebpageDiffCard({ file, diff }: WebpageDiffCardProps) {
    const [open, setOpen] = useState(false);

    const meta = FILE_META[file] || FILE_META.html;
    const Icon = meta.Icon;
    const noChange = !diff || diff.summary === 'no change';

    return (
        <div
            className="my-1.5 rounded-lg border text-[12px] [border-color:var(--vsc-border,var(--border-subtle))] [background:var(--vsc-sidebar-bg,var(--bg-secondary))]"
        >
            <button
                type="button"
                onClick={() => setOpen((o: boolean) => !o)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left [color:var(--vsc-fg,var(--text-primary))]!"
            >
                <ChevronRight
                    size={12}
                    className={`[transition:transform_.12s] ${open ? '[transform:rotate(90deg)]' : '[transform:rotate(0deg)]'}`}
                />
                <Icon size={13} />
                <span className="font-mono truncate">{meta.label}</span>
                <span
                    className="ml-auto font-mono text-[11px] px-1.5 py-0.5 rounded"
                    style={{
                        color: noChange ? 'var(--vsc-fg-muted, var(--text-tertiary))' : '#fff',
                        background: noChange ? 'transparent' : summaryBackground(diff),
                    }}
                >
                    {diff?.summary || '—'}
                </span>
            </button>
            {open && diff?.hunks && diff.hunks.length > 0 && (
                <div
                    className="border-t font-mono text-[11px] overflow-x-auto [border-color:var(--vsc-border,var(--border-subtle))]! [background:var(--vsc-editor-bg,var(--bg-primary))]"
                >
                    {diff.hunks.map((h: DiffHunk, i: number) => {
                        const { sigil, bg, fg } = hunkLook(h.type);
                        return (
                            <div
                                key={i}
                                className="px-2.5 py-0.5 whitespace-pre"
                                style={{ background: bg, color: fg }}
                            >
                                {sigil}  {h.text === '' ? ' ' : h.text}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

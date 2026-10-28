import { Plus } from 'lucide-react';
import React, { useState, useRef, useEffect } from 'react';
import useOutsideDismiss from '@/hooks/useOutsideDismiss';
import type { TranslateFn } from '@/hooks/useTranslation';

interface CreateLabelInlineProps {
    onCreateLabel?: (name: string, color: string) => unknown;
    t: TranslateFn;
}

/* ─── Inline label creator (with color wheel) ─── */
const CreateLabelInline = ({ onCreateLabel, t }: CreateLabelInlineProps) => {
    const [isCreating, setIsCreating] = useState<boolean>(false);
    const [name, setName] = useState<string>('');
    const [color, setColor] = useState<string>('#6366f1');
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (isCreating && inputRef.current) inputRef.current.focus();
    }, [isCreating]);

    useOutsideDismiss(containerRef, () => { setIsCreating(false); setName(''); }, { enabled: isCreating, escape: false, defer: false });

    const handleCreate = async () => {
        const trimmed = name.trim();
        if (trimmed && onCreateLabel) {
            await onCreateLabel(trimmed, color);
            setName(''); setColor('#6366f1'); setIsCreating(false);
        }
    };

    if (!isCreating) {
        return (
            <button
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => { e.stopPropagation(); setIsCreating(true); }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--bg-secondary)] rounded-md transition-colors text-left text-[var(--text-tertiary)]"
            >
                <Plus className="w-3 h-3" /> {t ? t('sidebar.new_label') : 'New label'}
            </button>
        );
    }

    return (
        <div ref={containerRef} className="px-2 py-1.5" onClick={(e: React.MouseEvent<HTMLDivElement>) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5">
                <input
                    type="color"
                    value={color}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setColor(e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer border-0 p-0 bg-transparent [-webkit-appearance:none]"
                    title={t('sidebar.pick_color', 'Pick a color')}
                />
                <input
                    ref={inputRef}
                    value={name}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                        if (e.key === 'Enter' && name.trim()) handleCreate();
                        if (e.key === 'Escape') { setName(''); setIsCreating(false); }
                    }}
                    placeholder={t('sidebar.label_name_placeholder', 'Label name...')}
                    className="flex-1 text-[12px] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded px-2 py-1 outline-none focus:border-[var(--accent-primary)] text-[var(--text-primary)] min-w-0"
                />
                <button
                    onClick={handleCreate}
                    disabled={!name.trim()}
                    className="text-[11px] px-2 py-0.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)] font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                    {t ? t('common.add') : 'Add'}
                </button>
            </div>
        </div>
    );
};

export default CreateLabelInline;

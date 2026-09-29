import { Plus } from 'lucide-react';
import React, { useState, useRef, useEffect } from 'react';

/* ─── Inline label creator (with color wheel) ─── */
const CreateLabelInline = ({ onCreateLabel, t }) => {
    const [isCreating, setIsCreating] = useState(false);
    const [name, setName] = useState('');
    const [color, setColor] = useState('#6366f1');
    const inputRef = useRef(null);
    const containerRef = useRef(null);

    useEffect(() => {
        if (isCreating && inputRef.current) inputRef.current.focus();
    }, [isCreating]);

    useEffect(() => {
        if (!isCreating) return;
        const close = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target)) {
                setIsCreating(false); setName('');
            }
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [isCreating]);

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
                onClick={(e) => { e.stopPropagation(); setIsCreating(true); }}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[12px] hover:bg-[var(--bg-secondary)] rounded-md transition-colors text-left text-[var(--text-tertiary)]"
            >
                <Plus className="w-3 h-3" /> {t ? t('sidebar.new_label') : 'New label'}
            </button>
        );
    }

    return (
        <div ref={containerRef} className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-1.5">
                <input
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer border-0 p-0 bg-transparent"
                    title="Pick a color"
                    style={{ WebkitAppearance: 'none' }}
                />
                <input
                    ref={inputRef}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && name.trim()) handleCreate();
                        if (e.key === 'Escape') { setName(''); setIsCreating(false); }
                    }}
                    placeholder="Label name..."
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

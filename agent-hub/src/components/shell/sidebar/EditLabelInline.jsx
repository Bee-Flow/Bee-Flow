import { X } from 'lucide-react';
import React, { useState, useRef, useEffect } from 'react';

/* ─── Inline label editor ─── */
const EditLabelInline = ({ label, onSave, onCancel, t }) => {
    const [name, setName] = useState(label.name);
    const [color, setColor] = useState(label.color);
    const inputRef = useRef(null);

    useEffect(() => {
        if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
    }, []);

    const handleSave = () => {
        const trimmed = name.trim();
        if (trimmed && (trimmed !== label.name || color !== label.color)) {
            onSave(label.id, { name: trimmed, color });
        }
        onCancel();
    };

    return (
        <div className="px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
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
                        if (e.key === 'Enter') handleSave();
                        if (e.key === 'Escape') onCancel();
                    }}
                    className="flex-1 text-[12px] bg-[var(--bg-secondary)] border border-[var(--border-subtle)] rounded px-2 py-1 outline-none focus:border-[var(--accent-primary)] text-[var(--text-primary)] min-w-0"
                />
                <button onClick={handleSave} className="text-[11px] px-2 py-0.5 rounded-md bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)] font-medium hover:opacity-90">
                    {t ? t('common.save') : 'Save'}
                </button>
                <button onClick={onCancel} className="text-[11px] p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]">
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
};

export default EditLabelInline;

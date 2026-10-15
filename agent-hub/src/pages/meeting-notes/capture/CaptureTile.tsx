import React from 'react';
import type { ComponentType, CSSProperties } from 'react';

interface CaptureTileProps {
    icon: ComponentType<{ className?: string }>;
    title: string;
    description: string;
    onClick: () => void;
    accent?: string;
}

export default function CaptureTile({ icon: Icon, title, description, onClick, accent = 'var(--accent-primary)' }: CaptureTileProps) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="group relative flex flex-col items-center text-center gap-3 p-6 rounded-2xl border transition-all hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus:ring-2"
            style={{
                background: 'var(--bg-secondary)',
                borderColor: 'var(--border-default)',
                color: 'var(--text-primary)',
                '--tw-ring-color': accent,
            } as CSSProperties}
        >
            <div
                className="w-14 h-14 rounded-2xl flex items-center justify-center transition-transform group-hover:scale-110"
                style={{
                    background: `color-mix(in srgb, ${accent} 14%, transparent)`,
                    color: accent,
                }}
            >
                <Icon className="w-7 h-7" />
            </div>
            <div className="font-semibold text-base">{title}</div>
            <div className="text-xs leading-relaxed text-[var(--text-muted)]">
                {description}
            </div>
        </button>
    );
}

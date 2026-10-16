import React from 'react';

/** The full-screen placeholder while the agent loads. */
export function EmbedLoading() {
    return (
        <div className="h-screen w-full flex items-center justify-center bg-[var(--bg-primary)]">
            <div className="flex flex-col items-center gap-3">
                <div className="w-8 h-8 border-3 border-[var(--border-default)] border-t-[var(--accent-primary)] rounded-full animate-spin" />
                <p className="text-sm text-[var(--text-muted)]">Loading...</p>
            </div>
        </div>
    );
}

/** The full-screen message when the agent cannot be shown. */
export function EmbedError({ error }: { error: string }) {
    return (
        <div className="h-screen w-full flex items-center justify-center bg-[var(--bg-primary)]">
            <div className="flex flex-col items-center gap-3 p-6 text-center">
                <div className="text-3xl">⚠️</div>
                <p className="text-sm text-red-400">{error}</p>
            </div>
        </div>
    );
}

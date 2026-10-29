import React from 'react';

/**
 * Three pulsing CheckCard-shaped skeletons. Used on first load.
 */
export function CheckCardSkeleton({ count = 3 }: { count?: number }) {
    return (
        <div className="[display:flex] [flex-direction:column] [gap:10px]">
            {Array.from({ length: count }).map((_, i) => (
                <div key={i} className="animate-pulse" style={{
                    border: '1px solid var(--border-default)',
                    borderLeft: '4px solid var(--bg-tertiary)',
                    background: 'var(--bg-secondary)',
                    borderRadius: 10, padding: '16px 18px',
                    display: 'flex', flexDirection: 'column', gap: 10,
                }}>
                    <div className="[display:flex] [gap:12px] [align-items:center]">
                        <div className="[width:22px] [height:22px] [border-radius:50%] [background:var(--bg-tertiary)]" />
                        <div className="[flex:1] [display:flex] [flex-direction:column] [gap:6px]">
                            <div className="[width:40%] [height:12px] [border-radius:4px] [background:var(--bg-tertiary)]" />
                            <div className="[width:70%] [height:10px] [border-radius:4px] [background:var(--bg-tertiary)]" />
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}

/** Hero skeleton for the Overview page — ring placeholder + stats. */
export function OverviewSkeleton() {
    return (
        <div className="animate-pulse" style={{
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border-default)',
            borderRadius: 14, padding: 24,
            display: 'flex', gap: 24, alignItems: 'center',
        }}>
            <div className="[width:140px] [height:140px] [border-radius:50%] [background:var(--bg-tertiary)] [flex-shrink:0]" />
            <div className="[flex:1] [display:flex] [flex-direction:column] [gap:10px]">
                <div className="[width:60%] [height:18px] [border-radius:4px] [background:var(--bg-tertiary)]" />
                <div className="[width:80%] [height:12px] [border-radius:4px] [background:var(--bg-tertiary)]" />
                <div className="[display:flex] [gap:12px] [margin-top:10px]">
                    {[0, 1, 2, 3].map(i => (
                        <div key={i} className="[width:60px] [height:40px] [border-radius:6px] [background:var(--bg-tertiary)]" />
                    ))}
                </div>
            </div>
        </div>
    );
}

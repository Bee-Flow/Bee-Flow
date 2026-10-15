import React from 'react';
import DesignEditor from '../DesignEditor';

interface DesignInspectorProps {
    design: Record<string, unknown>;
    onChange: (design: Record<string, unknown>) => void;
}

/**
 * Design inspector — hosts the site-wide brand editor (colors, fonts, logo,
 * favicon, radius, theme). DesignEditor brings its own heading + scroll
 * container. Edits flow through `onChange` → updateDesign → the shared
 * 'site' save slot (coalesces with chrome edits — do not split).
 */
export default function DesignInspector({ design, onChange }: DesignInspectorProps) {
    return (
        <div className="h-full flex flex-col min-h-0">
            <DesignEditor design={design} onChange={onChange} />
        </div>
    );
}

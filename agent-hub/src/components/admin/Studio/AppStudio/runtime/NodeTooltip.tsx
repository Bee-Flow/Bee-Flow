import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * App Studio runtime: the `tooltip` key of a node (schema 3, server/appStudio/componentSpecs/
 * keys/node/tooltip.js), following the WAI-ARIA tooltip pattern.
 *
 * The text is plain (React writes it as text) and always in the DOM as role="tooltip", hidden
 * until the pointer rests on the component or focus enters it; Escape hides it again. The first
 * control inside the component is described by it (aria-describedby); a component without one
 * becomes focusable itself, so a keyboard can reach the text too. Closed is the state of a first
 * paint, a screenshot and the headless render.
 */

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function NodeTooltip({ text, children }: { text: string; children: ReactNode }) {
    const id = useId();
    const wrapRef = useRef<HTMLDivElement>(null);
    const [open, setOpen] = useState(false);

    // The described element is found in the DOM after mount: the first control inside, or the
    // wrapper itself (made focusable) when the component has none.
    useEffect(() => {
        const wrap = wrapRef.current;
        if (!wrap) return undefined;
        const target = wrap.querySelector(FOCUSABLE) ?? wrap;
        const before = target.getAttribute('aria-describedby');
        target.setAttribute('aria-describedby', before ? `${before} ${id}` : id);
        if (target === wrap) wrap.setAttribute('tabindex', '0');
        return () => {
            if (before) target.setAttribute('aria-describedby', before); else target.removeAttribute('aria-describedby');
            if (target === wrap) wrap.removeAttribute('tabindex');
        };
    }, [id]);

    return (
        <div
            ref={wrapRef}
            className="relative bfa-tooltip__anchor"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}
            onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); } }}
            data-app-tooltip={open ? 'open' : 'closed'}
        >
            {children}
            <div
                id={id}
                role="tooltip"
                hidden={!open}
                className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 w-max max-w-xs -translate-x-1/2 px-2 py-1 text-xs [background:var(--text-primary)] [color:var(--bg-primary)] [border-radius:var(--app-radius)] bfa-tooltip__bubble"
            >
                {text}
            </div>
        </div>
    );
}

import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import renderInlineMarkdown from '../markdownInline';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { ROLE_COLORS } from '../styleResolver';

/** App Studio runtime — 'callout'. Spec: server/appStudio/componentSpecs.js. */

// The tone hexes are ROLE_COLORS (styleResolver) — the same house hexes the
// file used to duplicate, so the rendering stays byte-identical.
const TONES = {
    info: { color: ROLE_COLORS.info, Icon: Info },
    success: { color: ROLE_COLORS.success, Icon: CheckCircle2 },
    warning: { color: ROLE_COLORS.warning, Icon: AlertTriangle },
    danger: { color: ROLE_COLORS.danger, Icon: AlertCircle },
};

export default function AppCallout({ node }) {
    const { actionState, dataState, scope } = useRuntime();
    const { title = null, text = '', tone = 'info', meta = null } = node.props || {};
    const bag = { actionState, dataState, scope };

    // textFrom wins over the literal when it resolves to text (the
    // markdown.contentFrom pattern); the literal stays the fallback.
    const { value: boundText } = resolveBinding(node.props?.textFrom, bag);
    const shownText = typeof boundText === 'string' && boundText ? boundText : (text || '');

    // toneFrom: a runtime value outside the tone vocabulary falls back to the
    // static `tone` prop — a half-mapped status column must not blank the note.
    const { value: boundTone } = resolveBinding(node.props?.toneFrom, bag);
    const effectiveTone = typeof boundTone === 'string' && TONES[boundTone] ? boundTone : tone;
    const { color, Icon } = TONES[effectiveTone] || TONES.info;

    const { value: boundMeta } = resolveBinding(node.props?.metaFrom, bag);
    const shownMeta = boundMeta != null && boundMeta !== '' && typeof boundMeta !== 'object'
        ? String(boundMeta)
        : meta;

    // A long note — an AI summary, a status explanation — is worth having and
    // not worth six lines of permanent screen. Collapsed, it is one line you
    // read at a glance; the full text arrives on hover or keyboard focus, in a
    // panel that overlays rather than pushes, so nothing below it moves.
    const collapsible = node.props?.collapsible === true;

    return (
        <div
            className={`flex gap-2.5 px-3 py-2.5 text-sm${collapsible ? ' app-callout--collapsed items-center' : ' items-start'}`}
            style={{
                background: `${color}1a`, // ~10% alpha tint
                borderLeft: `3px solid ${color}`,
                borderRadius: 'var(--app-radius)',
                color: 'var(--text-primary)',
            }}
            data-app-callout={effectiveTone}
            tabIndex={collapsible ? 0 : undefined}
        >
            <Icon className={`w-4 h-4 shrink-0${collapsible ? '' : ' mt-0.5'}`} style={{ color }} aria-hidden="true" />
            <div className="min-w-0">
                {title ? <div className="font-medium">{title}</div> : null}
                <div className="app-callout__body" style={{ color: 'var(--text-secondary)' }}>
                    {renderInlineMarkdown(shownText)}
                </div>
                {/* The hover panel repeats what the line above already carries in
                    full — CSS truncates it, the DOM does not — so assistive tech
                    must not read it twice. */}
                {collapsible && shownText ? (
                    <div className="app-callout__peek" aria-hidden="true">
                        {renderInlineMarkdown(shownText)}
                    </div>
                ) : null}
            </div>
            {shownMeta ? (
                <div
                    className="ml-auto shrink-0 whitespace-nowrap text-xs mt-0.5"
                    style={{ color: 'var(--text-muted)' }}
                    data-app-callout-meta="true"
                >
                    {shownMeta}
                </div>
            ) : null}
        </div>
    );
}

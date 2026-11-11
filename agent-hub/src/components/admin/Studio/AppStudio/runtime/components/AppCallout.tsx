import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { LucideIcon } from 'lucide-react';
import renderInlineMarkdown from '../markdownInline';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import type { AppNode } from '../../inspector/appDefinition';
import type { BindingInput } from '../resolveBinding.types';
import { ROLE_COLORS } from '../styleResolver.constants';
import { textPartClasses } from '../styleKnobs/text';

/** App Studio runtime — 'callout'. Spec: server/appStudio/componentSpecs.js. */

// The tone hexes are ROLE_COLORS (styleResolver) — the same house hexes the
// file used to duplicate, so the rendering stays byte-identical.
const TONES: Record<string, { color: string; Icon: LucideIcon }> = {
    info: { color: ROLE_COLORS.info, Icon: Info },
    success: { color: ROLE_COLORS.success, Icon: CheckCircle2 },
    warning: { color: ROLE_COLORS.warning, Icon: AlertTriangle },
    danger: { color: ROLE_COLORS.danger, Icon: AlertCircle },
};

interface CalloutProps {
    title?: string | null;
    text?: string;
    tone?: string;
    meta?: string | null;
    textFrom?: BindingInput;
    toneFrom?: BindingInput;
    metaFrom?: BindingInput;
    collapsible?: boolean;
    variant?: string;
}

/**
 * The box of the callout for `props.variant` (since 3). soft, absent and anything unknown are
 * today's tinted block with a tone edge. outline is transparent with a tone border. solid is
 * the tone colour, darkened toward black the way the danger button is so that white text clears
 * 4.5:1 on every tone, and its text is white.
 */
function boxFor(variant: string | undefined, color: string): { box: CSSProperties; solid: boolean; iconColor: string } {
    if (variant === 'outline') {
        return { box: { background: 'transparent', border: `1px solid ${color}`, borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' }, solid: false, iconColor: color };
    }
    if (variant === 'solid') {
        return { box: { background: `color-mix(in srgb, ${color} 72%, #000)`, borderRadius: 'var(--app-radius)', color: '#ffffff' }, solid: true, iconColor: 'currentColor' };
    }
    return {
        box: { background: `${color}1a`, borderLeft: `3px solid ${color}`, borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' },
        solid: false,
        iconColor: color,
    };
}

export default function AppCallout({ node }: { node: AppNode<CalloutProps> }) {
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
    const look = boxFor(node.props?.variant, color);

    return (
        <div
            className={`flex gap-2.5 px-3 py-2.5 text-sm${collapsible ? ' app-callout--collapsed items-center' : ' items-start'}${textPartClasses(node.style)} bfa-callout__root`}
            style={look.box}
            data-app-callout={effectiveTone}
            tabIndex={collapsible ? 0 : undefined}
        >
            <Icon className={`w-4 h-4 shrink-0${collapsible ? '' : ' mt-0.5'} bfa-callout__icon`} style={{ color: look.iconColor }} aria-hidden="true" />
            <div className="min-w-0">
                {title ? <div className="font-medium bfa-callout__title">{title}</div> : null}
                <div className={`app-callout__body${look.solid ? '' : ' text-[var(--text-secondary)]'} bfa-callout__body`}>
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
                    className={`ml-auto shrink-0 whitespace-nowrap text-xs mt-0.5${look.solid ? ' opacity-80' : ' text-[var(--text-muted)]'} bfa-callout__meta`}
                    data-app-callout-meta="true"
                >
                    {shownMeta}
                </div>
            ) : null}
        </div>
    );
}

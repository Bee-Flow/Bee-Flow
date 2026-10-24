/**
 * ConversationHeader — the bar above a chat (C1): what this conversation is
 * called, what it is grounded on, whether it is being shielded, and the way
 * out to the notebook.
 *
 * The header replaces a bar that said nothing about the conversation at all:
 * a Cowork switch, a Notebook button, a Webpage button. Everything it adds is
 * a CLAIM about the chat underneath it, which is why the two statements are
 * derived in conversationHeaderClaims.js and why each of them can come back
 * as "say nothing".
 *
 * ── The shield pill is a runtime claim ──────────────────────────────────
 * A green dot in a header is read as "this is protected right now", not as
 * "somebody ticked a box in settings". Those are different sentences, and only
 * the first earns the dot. `headerShieldState()` therefore separates them:
 *
 *   'active'     → green dot, "Privacy Shield on". Enabled AND the detector
 *                  reachable — the claim the artboard draws.
 *   'unverified' → amber dot, and a sentence that says the configuration and
 *                  its limit in one breath. It never says "on" on its own.
 *   null         → no pill. Off, or unknown; an unknown status is not a
 *                  negative one, and neither may be dressed up as the other.
 *
 * ── What this component deliberately does NOT own ───────────────────────
 * The Chat ⇄ Cowork switch STAYS (C14, a conscious departure from the
 * artboard, which draws no such switch) — but it arrives through the `center`
 * slot rather than being imported here, because it decides what the composer
 * does and that is not the header's business. Same for the ⋯ menu (`menu`)
 * and the webpage button (`actions`): the header lays them out, the call site
 * owns their behaviour. The knowledge-base PICKER is the composer's; the pill
 * here is a statement with no chevron, so it never promises a control it does
 * not have.
 */

import { Plus } from 'lucide-react';
import React, { useMemo } from 'react';

import { headerKbState, headerShieldState } from './conversationHeaderClaims';
import useShieldStatus from '../../hooks/useShieldStatus';
import useTranslation from '../../hooks/useTranslation';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { KbRow } from './knowledgeBaseClaim';
import { kindColorVar, kindIcon } from '../shared/kindColors';

const BookIcon = kindIcon('kb');

/**
 * The artboard's header pill: a bordered, neutral chip — deliberately NOT the
 * tinted ComposerPill, which lives in a toolbar full of controls and is shaped
 * to look clickable. Nothing in this row is.
 */
function HeaderPill({ children, title, testId }: { children: React.ReactNode; title?: string; testId: string }) {
    return (
        <span
            data-testid={testId}
            title={title}
            className="[display:inline-flex] [align-items:center] [gap:5px] [flex-shrink:0] max-w-[220px] h-[22px] [padding:0_8px] [border-radius:9999px] [border:1px_solid_var(--border-default)] [background:var(--bg-card,var(--bg-secondary))] [color:var(--text-secondary)] [font-size:11px] [line-height:1] [white-space:nowrap]"
        >{children}</span>
    );
}

/** What this chat is grounded on — a statement, never a picker. */
function KbPill({ kb, t }: { kb: { count: number; names: string[]; name: string | null }; t: TranslateFn }) {
    const label = kb.name
        ? kb.name
        : t(kb.count === 1 ? 'chat.header.kb_count' : 'chat.header.kb_count_plural',
            kb.count === 1 ? '1 knowledge base' : '{count} knowledge bases',
            { count: kb.count });
    const title = kb.names.length > 0
        ? t('chat.header.kb_hint', 'This chat is grounded on {names}', { names: kb.names.join(', ') })
        : t('chat.header.kb_hint_unnamed', 'What this chat is grounded on');
    return (
        <HeaderPill testId="header-kb-pill" title={title}>
            <BookIcon
                aria-hidden="true"
                style={{ width: '12px', height: '12px', flexShrink: 0, color: kindColorVar('kb') }}
            />
            <span className="min-w-[0] [overflow:hidden] [text-overflow:ellipsis]">{label}</span>
        </HeaderPill>
    );
}

/**
 * The runtime claim, or the configuration claim, in words and colour that
 * cannot be mistaken for each other. `state` is never null here — a header
 * with nothing to say renders no pill at all.
 */
function ShieldPill({ state, t }: { state: 'active' | 'unverified'; t: TranslateFn }) {
    const active = state === 'active';
    return (
        <HeaderPill
            testId="header-shield-pill"
            title={t(
                active ? 'chat.header.shield_on_hint' : 'chat.header.shield_unverified_hint',
                active
                    ? 'Personal data is checked before it is sent'
                    : 'Privacy Shield is on, but the detector cannot be reached right now',
            )}
        >
            <span
                data-testid="header-shield-dot"
                data-shield-state={state}
                aria-hidden="true"
                style={{
                    width: '6px', height: '6px', borderRadius: '50%', flexShrink: 0,
                    // --success/--warning, never --status-*: the raw artboard
                    // names do not exist in this codebase.
                    background: active ? 'var(--success)' : 'var(--warning)',
                }}
            />
            <span className="min-w-[0] [overflow:hidden] [text-overflow:ellipsis]">
                {t(
                    active ? 'chat.header.shield_on' : 'chat.header.shield_unverified',
                    active ? 'Privacy Shield on' : 'Privacy Shield cannot check right now',
                )}
            </span>
        </HeaderPill>
    );
}

interface Props {
    title?: string;
    user?: object | null;
    isMobile?: boolean;
    shieldApplies?: boolean;
    availableKBs?: KbRow[] | null;
    selectedKBIds?: string[] | null;
    onToNotebook?: (() => void) | null;
    notebookOpen?: boolean;
    leading?: React.ReactNode;
    center?: React.ReactNode;
    actions?: React.ReactNode;
    menu?: React.ReactNode;
}

const ConversationHeader = ({
    title = '',
    user = null,
    isMobile = false,
    // FAIL CLOSED. The loudest privacy claim in the product is a green dot
    // saying "Privacy Shield on" above the conversation, and a default of
    // `true` hands that claim to any call site that simply forgot the prop.
    // Not every send route is shielded — the Builder composer posts to
    // `routes/ai/automationBuilder/chatStream.js`, which applies no shield at
    // all — so "is this route shielded?" is exactly the question a default
    // must not answer optimistically. `InputArea.jsx` defaults the same
    // question to false for the same reason; unknown narrows to silence.
    shieldApplies = false,
    availableKBs = null,
    selectedKBIds = null,
    onToNotebook = null,
    notebookOpen = false,
    leading = null,
    center = null,
    actions = null,
    menu = null,
}: Props) => {
    const { t } = useTranslation();

    // WHO MAY BE TOLD — the composer's rule, one surface further. Every pill
    // needs a signed-in user: what an organisation grounds its chats on, and
    // how it has configured its shield, is internal configuration and not
    // something to hand an anonymous visitor on a customer's website. Phones
    // are excluded for a different reason: a 360px header truncates, and half
    // a privacy sentence is worse than none. The per-message badge still
    // reports what actually happened to each message, on every width.
    const canClaim = !!user && !isMobile;

    const { data: shieldStatus } = useShieldStatus({ enabled: canClaim && shieldApplies });
    const shieldState = shieldApplies ? headerShieldState(shieldStatus) : null;

    const kb = useMemo(
        () => (canClaim ? headerKbState({ availableKBs, selectedKBIds }) : null),
        [canClaim, availableKBs, selectedKBIds],
    );

    return (
        <header
            data-testid="conversation-header"
            className={`relative flex items-center ${isMobile ? 'px-3' : 'px-5'} bg-[var(--bg-primary)]/80 backdrop-blur-md sticky top-0 z-20`}
            style={{
                height: '48px', gap: '10px', flexShrink: 0,
                borderBottom: '1px solid var(--border-subtle)',
            }}
        >
            <div className="flex items-center gap-2 min-w-[0] [flex-shrink:1]">
                {leading}
                {title ? (
                    <h1
                        data-testid="conversation-title"
                        title={title}
                        className="[font-weight:600] [font-size:14px] [color:var(--text-primary)] min-w-[0] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]"
                    >{title}</h1>
                ) : null}
            </div>

            {canClaim && kb && <KbPill kb={kb} t={t} />}

            {canClaim && shieldState && <ShieldPill state={shieldState} t={t} />}

            {/* Centred on the pane rather than tucked in with the buttons —
                parity with the bar this replaces, and for the same reason:
                Notebook and Webpage open a panel beside the conversation,
                while this decides what the composer below it even does. */}
            {center && (
                <div className="absolute left-1/2 -translate-x-1/2 flex items-center">{center}</div>
            )}

            <div className="flex items-center gap-2 relative [margin-left:auto] [flex-shrink:0]">
                {typeof onToNotebook === 'function' && (
                    <button
                        type="button"
                        data-testid="header-to-notebook"
                        onClick={onToNotebook}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors"
                        style={{
                            borderColor: 'var(--border-default)',
                            background: notebookOpen
                                ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)'
                                : 'var(--bg-card, var(--bg-secondary))',
                            color: notebookOpen ? 'var(--accent-primary)' : 'var(--text-secondary)',
                        }}
                    >
                        {/* The plus belongs to "to notebook" — it is the
                            direction of travel. Closing is not an addition. */}
                        {!notebookOpen && <Plus aria-hidden="true" style={{ width: '13px', height: '13px' }} />}
                        {t(notebookOpen ? 'chat.header.close_notebook' : 'chat.header.to_notebook',
                            notebookOpen ? 'Close notebook' : 'To notebook')}
                    </button>
                )}
                {actions}
                {menu}
            </div>
        </header>
    );
};

export default ConversationHeader;

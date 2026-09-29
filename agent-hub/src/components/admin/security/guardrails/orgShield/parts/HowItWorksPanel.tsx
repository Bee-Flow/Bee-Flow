import {
    ArrowRight, Ban, Bot, Gauge, MessageSquareText, Replace, ScanSearch, Send,
    ShieldCheck, Tags, TriangleAlert, UserCheck, Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import Modal from '../../../../../shared/Modal';
import type { GuardStatus } from './DetectionStatusPill';

/**
 * "How this works" — the explanation, in the app.
 *
 * ── Why not a docs link ───────────────────────────────────────────────────
 * It was one, and that is wrong for this button in three ways. It leaves the
 * screen an admin is mid-way through configuring (with unsaved edits, which
 * in-app navigation cannot warn about); it is unreachable on an air-gapped
 * self-host, which is a large share of this product's installs; and the docs
 * page it pointed at describes an older version of this very screen. The
 * explanation belongs beside the controls it explains.
 *
 * Content-wise this is the four things an admin has to hold in their head to
 * use the page correctly — and every one of them is a mistake the old screen
 * actually produced, not a feature tour:
 *
 *   1. the ORDER (a path, and where each pane sits on it),
 *   2. that step 3 always runs and step 4 only for an outside model — the
 *      commonest misreading by a wide margin,
 *   3. that a category not ticked is never even asked of the model,
 *   4. that the scanner is a separate service, and nothing here works without
 *      it.
 *
 * The steps carry the SAME numbers as the path strip above the page, so "step
 * 3" means one thing wherever it is read. "Your own data" is step 2 there;
 * its text says it is found in the same scan as step 1.
 */

type NoteTone = 'info' | 'warning' | 'error';

// Literal classes per tone: Tailwind only generates what it sees spelled out.
const NOTE_TONE: Record<NoteTone, { box: string; icon: string }> = {
    info: {
        box: 'bg-[color-mix(in_srgb,var(--info)_8%,transparent)] border-[color-mix(in_srgb,var(--info)_30%,transparent)]',
        icon: 'text-[var(--info-ink)]',
    },
    warning: {
        box: 'bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] border-[color-mix(in_srgb,var(--warning)_30%,transparent)]',
        icon: 'text-[var(--warning-ink)]',
    },
    error: {
        box: 'bg-[color-mix(in_srgb,var(--error)_8%,transparent)] border-[color-mix(in_srgb,var(--error)_30%,transparent)]',
        icon: 'text-[var(--error-ink)]',
    },
};

function Stage({ n, Icon, title, body, onGoTo, goToLabel }: {
    n?: number;
    Icon: LucideIcon;
    title: string;
    body: string;
    onGoTo?: () => void;
    goToLabel?: string;
}) {
    return (
        <div className="flex gap-3">
            <span
                aria-hidden="true"
                className="w-7 h-7 rounded-lg grid place-items-center shrink-0 mt-0.5 bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-secondary)]"
            >
                <Icon className="w-[15px] h-[15px]" />
            </span>
            <div className="min-w-0">
                <h4 className="text-[13px] font-semibold m-0 text-[var(--text-primary)]">
                    {n != null && <span className="text-[var(--text-tertiary)]">{n}. </span>}
                    {title}
                </h4>
                <p className="text-xs leading-relaxed mt-0.5 mb-0 text-[var(--text-secondary)]">{body}</p>
                {onGoTo && (
                    <button
                        type="button"
                        onClick={onGoTo}
                        className="text-[11px] font-semibold inline-flex items-center gap-1 mt-1 hover:underline text-[var(--info-ink)]"
                    >
                        {goToLabel}
                        <ArrowRight className="w-3 h-3" aria-hidden="true" />
                    </button>
                )}
            </div>
        </div>
    );
}

function Note({ tone = 'info', Icon, children }: { tone?: NoteTone; Icon: LucideIcon; children: ReactNode }) {
    return (
        <div className={`flex gap-2.5 items-start rounded-xl px-3.5 py-3 border ${NOTE_TONE[tone].box}`}>
            <Icon className={`w-4 h-4 shrink-0 mt-px ${NOTE_TONE[tone].icon}`} aria-hidden="true" />
            <p className="text-xs leading-relaxed m-0 text-[var(--text-secondary)]">{children}</p>
        </div>
    );
}

/** The path, in the order a message travels it, numbered as on the strip. */
function PathStages({ go, t }: { go: (tab: string) => () => void; t: TranslateFn }) {
    return (
        <div className="flex flex-col gap-3.5">
            <Stage
                Icon={MessageSquareText}
                title={t('admin.shield_hiw_in_title', 'Someone sends a message')}
                body={t('admin.shield_hiw_in_body',
                    'A chat, an agent, or — if you leave “Also protect routines” on — a routine running overnight with nobody watching.')}
            />
            <Stage
                n={1}
                Icon={ScanSearch}
                title={t('admin.shield_tab_detection', 'What we look for')}
                body={t('admin.shield_hiw_detect_body',
                    'The text is scanned for the kinds of personal data you ticked. A kind you did NOT tick is never asked of the model, so it can never be found — which is why a shield that is on with nothing ticked finds nothing at all.')}
                onGoTo={go('detection')}
                goToLabel={t('admin.shield_hiw_open_detection', 'Open the matrix')}
            />
            <Stage
                n={2}
                Icon={Tags}
                title={t('shield_data.tab_label', 'Your own data')}
                body={t('shield_data.hiw_body',
                    'In the same scan we also look for the kinds of data only your organisation has, like project code names or customer numbers. You add them yourself, test them on example sentences, and each gets its own placeholder, such as [project_code_1].')}
                onGoTo={go('owndata')}
                goToLabel={t('shield_data.hiw_open', 'Open Your own data')}
            />
            <Stage
                n={3}
                Icon={Replace}
                title={t('admin.shield_posture_action', 'When we find something')}
                body={t('admin.shield_hiw_process_body',
                    'Whatever was found is either replaced with placeholders — the AI sees [email_1], never the address, and Bee Flow puts the real value back in the answer — or the message is stopped and the person is asked to rewrite it. This gate closes on EVERY message.')}
                onGoTo={go('processing')}
                goToLabel={t('admin.shield_hiw_open_processing', 'Open the two checks')}
            />
            <Stage
                n={4}
                Icon={Send}
                title={t('admin.shield_tab_outbound', 'Leaving your org')}
                body={t('admin.shield_hiw_outbound_body',
                    'Only if the model runs OUTSIDE your organisation: one more look, which can pause and let the person decide. This is also where you say which kinds a connected app may never carry out — Gmail, Drive, a web search.')}
                onGoTo={go('outbound')}
                goToLabel={t('admin.shield_hiw_open_outbound', 'Open the two checks')}
            />
            <Stage
                Icon={Bot}
                title={t('admin.shield_hiw_out_title', 'The AI answers')}
                body={t('admin.shield_hiw_out_body',
                    'And everything that happened on the way is recorded — who, what was found, what was done about it, and where any outgoing call went.')}
                onGoTo={go('activity')}
                goToLabel={t('admin.shield_hiw_open_activity', 'Open the evidence')}
            />
        </div>
    );
}

function WorthKnowing({ t }: { t: TranslateFn }) {
    return (
        <div className="flex flex-col gap-2.5">
            <h4 className="text-[13px] font-semibold m-0 text-[var(--text-primary)]">
                {t('admin.shield_hiw_also_title', 'Three more things worth knowing')}
            </h4>
            <Stage
                Icon={Gauge}
                title={t('admin.shield_hiw_dial_title', 'The strictness dial runs backwards')}
                body={t('admin.shield_hiw_dial_body',
                    'It is a confidence threshold, so a LOWER percentage finds MORE. That is why the levels are named rather than numbered, and why the slider says “finds more” and “finds less” instead of 10% and 100%. Balanced is the setting every published quality figure was measured at.')}
            />
            <Stage
                Icon={Wrench}
                title={t('admin.shield_hiw_precedence_title', 'These rules run first')}
                body={t('admin.shield_hiw_precedence_body',
                    'Before any rules set on an individual agent. An agent can be stricter, never looser — if the two disagree, the stricter one wins.')}
            />
            <Stage
                Icon={Ban}
                title={t('admin.shield_hiw_exceptions_title', 'Two lists work the opposite way round')}
                body={t('shield_data.hiw_exceptions_body',
                    '“Your own data” adds your own words, formats and names on top of everything else. Lists of words and fixed formats keep working even when the detection service is down, because they need no model. “Never hide these” does the reverse: those values stay visible to the AI, in every category, permanently, and they have to match exactly. Allowing “Shell” does not allow “Shell Advies BV”.')}
            />
        </div>
    );
}

export function HowItWorksPanel({ open, onClose, guard, onGoTo, t }: {
    open: boolean;
    onClose: () => void;
    guard: GuardStatus | null;
    onGoTo?: (tab: string) => void;
    t: TranslateFn;
}) {
    const guardDown = !!guard && (guard.configured === false || guard.reachable === false);

    const go = (tab: string) => () => { onClose(); onGoTo?.(tab); };

    return (
        <Modal
            open={open}
            onClose={onClose}
            placement="right"
            size="md"
            title={t('admin.shield_hiw_title', 'How the Privacy Shield works')}
            description={t('admin.shield_hiw_subtitle',
                'What happens to a message, in the order it happens, and which of these panes decides what.')}
        >
            <div className="flex flex-col gap-4">
                <Note tone="info" Icon={ShieldCheck}>
                    {t('admin.shield_hiw_own_server',
                        'All of this runs on your own server. A message is read and stripped BEFORE it goes anywhere, and nothing is sent elsewhere in order to check it.')}
                </Note>

                <PathStages go={go} t={t} />

                <Note tone="warning" Icon={UserCheck}>
                    <strong className="text-[var(--text-primary)]">
                        {t('shield_shell.hiw_two_checks_lead', 'Steps 3 and 4 are not alternatives.')}
                    </strong>{' '}
                    {t('shield_shell.hiw_two_checks',
                        'Step 3 is the gate that always closes; step 4 is one extra look, only before a model outside your organisation, and the only place an employee gets a say. Stopping the message at step 3 does not produce the Ask dialog — that is step 4 on “Ask”.')}
                </Note>

                <WorthKnowing t={t} />

                <Note tone={guardDown ? 'error' : 'info'} Icon={guardDown ? TriangleAlert : ScanSearch}>
                    {guardDown
                        ? t('admin.shield_hiw_guard_down',
                            'Right now the detection service is not answering, so no personal data is being FOUND — every category on this page is inactive until it is back. Your own words and patterns still work; they need no model. A platform administrator installs and restarts it.')
                        : t('admin.shield_hiw_guard',
                            'The scanning itself is done by a separate service on your own infrastructure (the PII Guard). If it is ever stopped or unreachable, the categories on this page find nothing until it is back — the header says so when that happens — while your own words and patterns keep working, because they need no model.')}
                </Note>
            </div>
        </Modal>
    );
}

export default HowItWorksPanel;

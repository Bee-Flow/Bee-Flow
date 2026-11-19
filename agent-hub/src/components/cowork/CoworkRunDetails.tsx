/**
 * What an opened run shows besides its result: the review it asked for and how that was handled, what it used (each
 * tool with how its calls ended; a call a policy refused stands out, with the reason in plain words), the skills that
 * took part, and the way into the conversation it wrote, which is Cowork's and not in the chat history.
 *
 * The server keeps names, outcomes and counts only (server/core/cowork/runActivity.mts): no tool arguments, no mail
 * text. A run from before that was kept has no activity, and then this block says nothing about it.
 */
import { MessageSquare, ShieldAlert } from 'lucide-react';
import { fullTimestamp } from './coworkFormat';
import { openRunConversation, refusalReasonText, resolutionText } from './coworkReview';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { CoworkRun, CoworkRunTool } from '../../api/cowork.types';

function ToolLine({ tool, t }: { tool: CoworkRunTool; t: TranslateFn }) {
    const counts = [
        tool.ok > 0 ? t('cowork_review.activity.ok', '{count}× done', { count: tool.ok }) : '',
        tool.failed > 0 ? t('cowork_review.activity.failed', '{count}× failed', { count: tool.failed }) : '',
        tool.refused > 0 ? t('cowork_review.activity.refused', '{count}× refused', { count: tool.refused }) : '',
    ].filter(Boolean).join(' · ');
    const refused = tool.refused > 0;
    return (
        <li data-testid="cowork-run-tool" data-refused={refused ? 'true' : undefined} className="flex flex-col gap-0.5">
            <span className={`inline-flex items-center gap-1.5 text-[12px] ${refused ? 'text-[var(--error-ink)] font-medium' : 'text-[var(--text-secondary)]'}`}>
                {refused && <ShieldAlert aria-hidden="true" className="w-3.5 h-3.5 flex-shrink-0" />}
                <code className="text-[11.5px]">{tool.name}</code>
                {tool.app && <span className="text-[11px] text-[var(--text-tertiary)]">{tool.app}</span>}
                <span className="text-[11px] text-[var(--text-tertiary)]">{counts}</span>
            </span>
            {tool.reasons.map((code) => (
                <span key={code} className="pl-5 text-[11.5px] text-[var(--error-ink)]">{refusalReasonText(code, t)}</span>
            ))}
        </li>
    );
}

function Activity({ run, t }: { run: CoworkRun; t: TranslateFn }) {
    const activity = run.activity;
    if (!activity) return null;
    // Refusals first: they are what someone opening this row is looking for.
    const tools = [...activity.tools].sort((a, b) => b.refused - a.refused);
    return (
        <div data-testid="cowork-run-activity" className="flex flex-col gap-1.5 pb-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                {t('cowork_review.activity.heading', 'What it used')}
            </span>
            {tools.length === 0
                ? <p className="text-[12px] text-[var(--text-tertiary)]">{t('cowork_review.activity.no_tools', 'No actions: it only wrote an answer.')}</p>
                : <ul className="flex flex-col gap-1">{tools.map((tool) => <ToolLine key={tool.name} tool={tool} t={t} />)}</ul>}
            {activity.skills.length > 0 && (
                <p className="text-[12px] text-[var(--text-secondary)]">
                    {t('cowork_review.activity.skills', 'Skills: {list}', {
                        list: activity.skills.map((s) => (s.how === 'static'
                            ? t('cowork_review.activity.skill_static', '{name} (always on)', { name: s.name })
                            : t('cowork_review.activity.skill_activated', '{name} (loaded when needed)', { name: s.name }))).join(', '),
                    })}
                </p>
            )}
        </div>
    );
}

function Review({ run, t }: { run: CoworkRun; t: TranslateFn }) {
    const review = run.review;
    if (!review) return null;
    const when = review.resolvedAt ? fullTimestamp(review.resolvedAt, t) : '';
    return (
        <div data-testid="cowork-run-review" className="flex flex-col gap-1 pb-2">
            <span className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--warning-ink)]">
                {t('cowork_review.history.asked', 'The agent asked for your review')}
            </span>
            <p className="text-[12.5px] whitespace-pre-wrap break-words text-[var(--text-secondary)]">{review.reason}</p>
            {review.question && <p className="text-[12.5px] whitespace-pre-wrap break-words text-[var(--text-secondary)]">{review.question}</p>}
            <p className="text-[11.5px] text-[var(--text-tertiary)]">{resolutionText(review, t, when)}</p>
        </div>
    );
}

interface CoworkRunDetailsProps {
    run: CoworkRun;
    /** The agent the item runs as: the conversation opens in its chat. */
    agentId?: string | null;
    title: string;
    t: TranslateFn;
}

export default function CoworkRunDetails({ run, agentId, title, t }: CoworkRunDetailsProps) {
    const canOpen = !!(agentId && run.conversationId);
    return (
        <>
            {run.mailSubject && (
                <p className="text-[11px] pb-2 text-[var(--text-tertiary)]">
                    {t('cowork_review.queue.mail_subject', 'E-mail: {subject}', { subject: run.mailSubject })}
                </p>
            )}
            <Review run={run} t={t} />
            <Activity run={run} t={t} />
            {canOpen && (
                <button
                    type="button"
                    data-testid="cowork-run-open-conversation"
                    onClick={() => openRunConversation(agentId as string, run, title)}
                    className="mb-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--accent-primary)] hover:underline"
                >
                    <MessageSquare aria-hidden="true" className="w-3.5 h-3.5" />
                    {t('cowork_review.history.open_conversation', 'Open the conversation of this run')}
                </button>
            )}
        </>
    );
}

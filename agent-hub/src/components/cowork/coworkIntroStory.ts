import type { TranslateFn } from '@/hooks/useTranslation';
import type { ActivityTone } from './coworkOrbFrame';
import type { OrbWork } from './CoworkOrbSources';

/** One moment of the tour: what Bee says, what the orb does, and what is shown under the line. */
export interface IntroBeat {
    id: string;
    line: string;
    action: NonNullable<OrbWork['action']>;
    tone: ActivityTone;
    /** The step of the plan that is in progress. The step rail shows only while there is one. */
    step?: string;
    /** What you say to Bee, as a chat bubble. */
    said?: string;
    /** What Bee shows you, as a card (Markdown). */
    sample?: string;
    /** The team desk card, before or after Noor accepted. */
    desk?: 'invited' | 'connected';
}

/** The tour as one conversation: you ask, Bee builds and tests, you get the result, the team joins. */
export function coworkIntroStory(t: TranslateFn): IntroBeat[] {
    return [
        { id: 'hello', action: 'rest', tone: 'rest', line: t("cowork_home.tour.hello", "Hi, I’m Bee. Give me a minute and I’ll show you how we work together.") },
        { id: 'request', action: 'rest', tone: 'rest', line: t("cowork_home.tour.request", "Imagine a week full of meetings. Just tell me what you need, in your own words."), said: t("cowork_home.tour.request_said", "Make me a weekly digest of our meetings.") },
        { id: 'time', action: 'ask', tone: 'thinking', line: t("cowork_home.tour.time", "A weekly digest, got it. When do you want it?"), said: t("cowork_home.tour.time_said", "Monday morning at nine.") },
        { id: 'find', action: 'executing', tone: 'executing', line: t("cowork_home.tour.find", "First I find your meetings in Meeting Notes. I only see what you’re allowed to see."), sample: t("cowork_home.tour.find_sample", "**Meeting Notes** · Pilot meeting\n\nDecision · The pilot starts Monday.\n\nAction · Alex shares the checklist on Friday.") },
        { id: 'plan', action: 'creating', tone: 'thinking', step: 'week', line: t("cowork_home.tour.plan", "Then I turn your request into steps. They run every Monday at nine.") },
        { id: 'try', action: 'testing', tone: 'executing', step: 'check', line: t("cowork_home.tour.try", "Before anything goes live, I try it out. One note turns out to be empty.") },
        { id: 'fix', action: 'repair', tone: 'repair', step: 'check', line: t("cowork_home.tour.fix", "So I skip empty notes and try again."), sample: t("cowork_home.tour.fix_sample", "**Second try** · passed\n\n1 note read · 1 empty note skipped") },
        { id: 'digest', action: 'thinking', tone: 'thinking', step: 'write', line: t("cowork_home.tour.digest", "It works. Here’s your digest: decisions, owners and deadlines."), sample: t("cowork_home.story.digest_sample", "### Weekly digest\n\n**Decision** · The pilot starts Monday.\n\n**Action** · Alex will share the checklist on Friday.") },
        { id: 'edit', action: 'edit', tone: 'rest', step: 'write', line: t("cowork_home.tour.edit", "Want it differently? Just say so."), said: t("cowork_home.tour.edit_said", "Group the actions per person, with the deadline.") },
        { id: 'approve', action: 'saving', tone: 'rest', step: 'result', line: t("cowork_home.tour.approve", "Done. Approve it once and I’ll run it every Monday."), sample: t("cowork_home.story.approve_sample", "### Alex\n\nShare the pilot checklist · **Friday**\n\n**Ready for your approval** · Mondays at 09:00") },
        { id: 'desk', action: 'creating', tone: 'rest', desk: 'invited', line: t("cowork_home.tour.desk", "Working with others? On a team desk, your digest kicks off Noor’s agenda.") },
        { id: 'handoff', action: 'deliver', tone: 'executing', desk: 'connected', line: t("cowork_home.tour.handoff", "Noor runs her part with her own apps and permissions. Only the result is passed on.") },
    ];
}

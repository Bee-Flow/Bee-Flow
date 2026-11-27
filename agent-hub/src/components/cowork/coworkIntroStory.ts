import type { TranslateFn } from '@/hooks/useTranslation';

export function coworkIntroStory(t: TranslateFn) {
    return [
        { id: 'hello', action: 'rest', line: t("cowork_home.tour.hello", "Hi, I’m Bee. It’s Friday afternoon and your team has just wrapped up its last meeting."), sample: '' },
        { id: 'request', action: 'thinking', line: t("cowork_home.tour.request", "On Monday you’ll want this week’s decisions in one place. Just ask, in your own words."), sample: t("cowork_home.story.request_sample", "“Make me a weekly meeting digest.”") },
        { id: 'time', action: 'ask', line: t("cowork_home.tour.time", "Weekly, got it. When should it be ready?"), sample: t("cowork_home.story.time_sample", "**When should I run?**\n\nMonday · 09:00") },
        { id: 'integrations', action: 'thinking', line: t("cowork_home.tour.integrations", "I look up your meetings in Meeting Notes, using only what you’re allowed to see."), sample: t("cowork_home.story.integrations_sample", "**Meeting Notes · Search results**\n\nPilot meeting · 20 November · Selected") },
        { id: 'fetch_note', action: 'executing', line: t("cowork_home.tour.fetch_note", "Here’s Friday’s pilot meeting. I save it to your team’s table, so Monday’s run has something to read."), sample: t("cowork_home.story.fetch_sample", "**Pilot meeting · 20 November**\n\nDecision · The pilot starts Monday.\n\nAction · Alex shares the checklist on Friday.") },
        { id: 'plan', action: 'creating', line: t("cowork_home.tour.plan", "Every Monday at nine, I look back at the week before."), sample: '' },
        { id: 'try', action: 'testing', line: t("cowork_home.tour.try", "Before anything goes live, I test it. One note turns out to have no summary."), sample: '' },
        { id: 'fix', action: 'repair', line: t("cowork_home.tour.fix", "So I adjust the check and test again. Empty notes are skipped and counted."), sample: t("cowork_home.story.fix_sample", "**Second trial** · 2 rows in the date range\n\n1 summary usable · 1 empty row skipped\n\nIf the usable count is zero, stop before the writing step.") },
        { id: 'digest', action: 'thinking', line: t("cowork_home.tour.digest", "Test passed. Here’s your digest: decisions, owners and deadlines."), sample: t("cowork_home.story.digest_sample", "### Weekly digest\n\n**Decision** · The pilot starts Monday.\n\n**Action** · Alex will share the checklist on Friday.") },
        { id: 'edit', action: 'edit', line: t("cowork_home.tour.edit", "Rather see it per person? Just say so."), sample: t("cowork_home.story.edit_sample", "“Group actions by owner and show the deadline.”") },
        { id: 'approve', action: 'saving', line: t("cowork_home.tour.approve", "Done. Approve it once and I’ll run it every Monday."), sample: t("cowork_home.story.approve_sample", "### Alex\n\nShare the pilot checklist · **Friday**\n\n**Ready for your approval** · Mondays at 09:00") },
        { id: 'share', action: 'deliver', line: t("cowork_home.tour.share", "Want Noor to follow along? Share the task, or link it to hers."), sample: t("cowork_home.story.share_sample", "**Share task with Noor** · View results\n\n**Team desk** · Weekly digest → Prepare team agenda") },
        { id: 'desk', action: 'creating', line: t("cowork_home.tour.desk", "On a team desk, your digest can kick off Noor’s Monday agenda."), sample: '' },
        { id: 'handoff', action: 'executing', line: t("cowork_home.tour.handoff", "She runs her part with her own apps and permissions. Only the result is passed on."), sample: '' },
        { id: 'control', action: 'edit', line: t("cowork_home.tour.control", "Prefer to steer yourself? Advanced puts the schedule, model and steps in one place."), sample: t("cowork_home.story.control_sample", "**Schedule** · Monday, 09:00\n\n**Model** · Thinking\n\n**Source** · Selected Meeting Notes summaries in your Bee Flow table") },
    ] as const;
}

import type { DraftStep, Pattern, PatternCadence, PatternDraft, RepeatingSuggestion } from '../../api/queries/automation/repeating';
import { buildMessageFromSuggestion } from './taskFormatters';

/**
 * The brief the automation builder gets when someone builds a pattern from
 * "Find repeating work": the scan's own build prompt, then the pattern as the
 * miner measured it (trigger, steps, rhythm, template, apps, time), so the
 * builder starts from what really repeats instead of from a title.
 *
 * Every figure comes from `suggestion.pattern`, which the server computed from
 * masked events: a template carries placeholders (<n>, <name>, <domain:A>),
 * never a real name, address or number. Nothing is estimated here, and a
 * missing figure is left out.
 *
 * The brief is English on purpose, like buildMessageFromSuggestion: it is
 * written for the builder model. An idea (no pattern) or a scan from before
 * the miner goes through buildMessageFromSuggestion, which RulesPanel keeps
 * using as well.
 */

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** What kind of work repeats, per miner kind. */
const KIND_BRIEF: Readonly<Record<string, string>> = Object.freeze({
    sequence: 'the same steps, done by hand one after the other',
    mail_template: 'e-mails that follow the same template',
    file_drop: 'a file that is saved on a steady rhythm',
    meeting_followup: 'the same follow-up work after a recurring meeting',
});

/** A step's kind when it names no app. */
const FAMILY_BRIEF: Readonly<Record<string, string>> = Object.freeze({
    ai: 'AI step',
    data: 'data step',
    branch: 'condition',
});

const HEADER = 'Context from the "Find repeating work" scan (privacy-filtered: names, addresses and numbers are masked as placeholders; use it to build the automation precisely):';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const clock = (h: number) => `${String(Math.max(0, Math.min(23, Math.round(h)))).padStart(2, '0')}:00`;

/**
 * The rhythm as a schedule: "every week on Monday at 09:00", or null when the
 * rhythm is irregular (a schedule would then be a guess).
 */
export function cadenceHint(c: PatternCadence | null | undefined): string | null {
    if (!c) return null;
    const day = typeof c.weekday === 'number' && WEEKDAY[c.weekday] ? ` on ${WEEKDAY[c.weekday]}` : '';
    const at = c.hourBand ? ` at ${clock(c.hourBand[0])}` : '';
    switch (c.kind) {
        case 'daily': return `every day${at}`;
        case 'weekdays': return `every weekday (Monday to Friday)${at}`;
        case 'weekly': return `every week${day}${at}`;
        case 'biweekly': return `every two weeks${day}${at}`;
        case 'monthly': return `once a month${at}`;
        default: return null;
    }
}

/** "- Seen 14 times in the last 90 days, on 9 different days, in 5 of 6 weeks." */
function seenLine(p: Pattern): string | null {
    if (!(p.occurrences > 0)) return null;
    const parts = [`Seen ${plural(p.occurrences, 'time', 'times')} in the last ${p.windowDays} days`];
    if (p.distinctDays > 0) parts.push(`on ${plural(p.distinctDays, 'different day', 'different days')}`);
    const { weeksPresent = 0, weeksWindow = 0 } = p.cadence;
    if (weeksPresent > 0 && weeksWindow > 0) parts.push(`in ${weeksPresent} of ${weeksWindow} weeks`);
    const early = p.confidence === 'early' ? ' (an early signal: there is little history yet)' : '';
    return `- ${parts.join(', ')}${early}.`;
}

type DraftTrigger = PatternDraft['trigger'];

function appTriggerLine(trig: DraftTrigger): string {
    let where = '';
    if (trig.provider && trig.event) where = ` (app event ${trig.provider} / ${trig.event})`;
    else if (trig.app) where = ` (${trig.app})`;
    return `- Suggested trigger: ${trig.label || 'an app event'}${where}`;
}

function suggestedTrigger(trig: DraftTrigger | undefined, hint: string | null): string {
    if (!trig) return hint ? '- Suggested trigger: a schedule' : '- Trigger: the scan found none that fits; ask which one to use.';
    if (trig.kind === 'app') return appTriggerLine(trig);
    if (trig.kind === 'schedule') return `- Suggested trigger: a schedule${trig.label ? ` (${trig.label})` : ''}`;
    return `- Suggested trigger: ${trig.label || 'run by hand'} (manual)`;
}

/** The trigger to start from, plus the rhythm: a schedule hint, or context when an app event starts it. */
function triggerLines(p: Pattern): string[] {
    const trig = p.draft?.trigger;
    const hint = cadenceHint(p.cadence);
    const lines = [suggestedTrigger(trig, hint)];
    if (!hint) return lines;
    lines.push(trig?.kind === 'app'
        ? `- Rhythm, for reference: this usually happens ${hint}.`
        : `- Schedule hint: run it ${hint}, when this work usually happens.`);
    return lines;
}

const stepWhere = (s: DraftStep): string => {
    if (s.app) return ` (${s.app})`;
    const family = FAMILY_BRIEF[s.family];
    return family ? ` (${family})` : '';
};

function stepLines(p: Pattern): string[] {
    const steps = p.draft?.steps ?? [];
    if (!steps.length) return [];
    return ['- Suggested steps:', ...steps.map((s, i) => `  ${i + 1}. ${s.label}${stepWhere(s)}`)];
}

function templateLine(template: string | null): string | null {
    if (!template) return null;
    const domains = /<domain:[A-Za-z0-9]+>/.test(template) ? ' <domain:A> stands for one sender\'s domain, kept anonymous.' : '';
    return `- Template (the parts in <angle brackets> change each time):${domains} "${template}"`;
}

function timeLine(p: Pattern): string | null {
    const range = p.minutesPerMonth;
    if (!range || !(range[1] > 0)) return null;
    const [lo, hi] = [Math.max(0, Math.round(range[0])), Math.round(range[1])];
    const basis = p.basis === 'measured' ? 'measured from the sessions' : 'estimated';
    return `- Time this takes now: about ${lo}–${hi} min per month (${basis})`;
}

/** The scan's build prompt, or a plain one from the title when the scan wrote none. */
function basePrompt(s: RepeatingSuggestion): string {
    const base = String(s.buildPrompt || '').trim();
    if (base) return base;
    return [`Build an automation for this repeating work: ${s.title}.`, String(s.description || '').trim()]
        .filter(Boolean).join(' ');
}

/**
 * The message for a fresh builder: auto-sent by "Build this", pre-filled by
 * "Adjust first". A suggestion without a pattern (an idea) gets the older
 * suggestion message unchanged.
 */
export function buildMessageFromPattern(s: RepeatingSuggestion | null | undefined): string {
    if (!s) return '';
    const p = s.pattern;
    if (!p) return buildMessageFromSuggestion(s);
    const missing = list(s.unavailableIntegrations);
    const apps = p.apps.length ? p.apps : list(s.requiredIntegrations);
    const ctx = [
        KIND_BRIEF[p.kind] ? `- What repeats: ${KIND_BRIEF[p.kind]}` : null,
        seenLine(p),
        ...triggerLines(p),
        ...stepLines(p),
        templateLine(p.template),
        apps.length ? `- Apps to use: ${apps.join(', ')}` : null,
        missing.length ? `- Not yet connected (mention if a connection is needed): ${missing.join(', ')}` : null,
        timeLine(p),
    ].filter((line): line is string => !!line);
    return [basePrompt(s), '', HEADER, ...ctx].join('\n');
}

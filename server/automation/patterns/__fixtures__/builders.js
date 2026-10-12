// @typecheck
'use strict';
/**
 * Building blocks for the golden event streams: a seeded PRNG, a clock, event
 * constructors and a noise generator. Everything is synthetic; no names,
 * addresses or domains of real people or companies appear anywhere.
 */

const { makeEvent } = require('../events');
const { subjectTemplate, filenameStem } = require('../templating');

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

// Saturday 3 October 2026, 18:00 UTC.
const NOW = Date.UTC(2026, 9, 3, 18, 0);
const TODAY = Date.UTC(2026, 9, 3);

/** Deterministic PRNG (mulberry32). */
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Timestamp `daysAgo` days before today at hh:mm UTC. */
const at = (daysAgo, h = 9, m = 0) => TODAY - daysAgo * DAY + h * HOUR + m * MIN;
const weekdayOf = (daysAgo) => new Date(at(daysAgo)).getUTCDay();

/** Day offsets within `span` days that fall on one of the weekdays. */
function daysOn(weekdays, span = 90, from = 0) {
    const out = [];
    for (let d = from; d < span; d++) if (weekdays.includes(weekdayOf(d))) out.push(d);
    return out;
}

const tool = (ts, verb, app, conv) => makeEvent({ ts, source: 'ledger', objectType: 'tool', app, verb, sessionKey: conv });
const mailIn = (ts, app, subject, o = {}) => makeEvent({
    ts, source: 'mail', objectType: 'mail', app, verb: 'mail.received', direction: 'in',
    template: subjectTemplate(subject), hasAttachment: !!o.attachment, bulk: !!o.bulk, domainPseudo: o.domain || 'dx',
});
const mailOut = (ts, app, subject, o = {}) => makeEvent({
    ts, source: 'mail', objectType: 'mail', app, verb: 'mail.sent', direction: 'out',
    template: subjectTemplate(subject), hasAttachment: !!o.attachment, domainPseudo: o.domain || 'dy',
});
const fileNew = (ts, app, name, folder, source = 'files') => makeEvent({
    ts, source, objectType: source === 'documents' ? 'document' : 'file', app,
    verb: source === 'documents' ? 'doc.uploaded' : 'file.created', template: filenameStem(name), sessionKey: folder,
});
const meeting = (ts, app, series) => makeEvent({ ts, source: 'meetings', objectType: 'meeting', app, verb: 'meeting.held', sessionKey: series });

/** A chat session: the tools in order, a few minutes apart. */
function session(ts, conv, steps, gapMin = 3) {
    return steps.map(([verb, app], i) => tool(ts + i * gapMin * MIN, verb, app, conv));
}

// A broad vocabulary for one-off work: the miner must not find patterns in it.
const NOISE_TOOLS = [
    ['gmail_read_message', 'gmail'], ['gmail_list_labels', 'gmail'], ['calendar_list_events', 'google-calendar'],
    ['calendar_create_event', 'google-calendar'], ['drive_search_files', 'google-drive'], ['drive_get_file', 'google-drive'],
    ['nextcloud_files_search', 'nextcloud'], ['nextcloud_deck_search_cards', 'nextcloud'], ['nextcloud_talk_send_message', 'nextcloud'],
    ['nextcloud_tasks_complete', 'nextcloud'], ['outlook_get_message', 'outlook'], ['outlook_list_folders', 'outlook'],
    ['teams_list_channels', 'teams'], ['teams_post_message', 'teams'], ['onedrive_list_files', 'onedrive'],
    ['onedrive_get_file', 'onedrive'], ['slack_search', 'slack'], ['slack_post_message', 'slack'],
    ['github_list_issues', 'github'], ['github_create_issue', 'github'], ['github_get_pull_request', 'github'],
    ['notion_search', 'notion'], ['notion_create_page', 'notion'], ['trello_list_cards', 'trello'],
    ['trello_move_card', 'trello'], ['hubspot_get_contact', 'hubspot'], ['hubspot_search_companies', 'hubspot'],
    ['web_search', 'web'], ['web_fetch', 'web'], ['kb_search', 'beeflow'], ['kb_get_document', 'beeflow'],
    ['weather_forecast', 'web'], ['translate_text', 'beeflow'], ['calc_expression', 'beeflow'],
    ['maps_lookup', 'web'], ['jira_get_issue', 'jira'], ['jira_search', 'jira'], ['confluence_search', 'confluence'],
    ['confluence_get_page', 'confluence'], ['zoom_list_meetings', 'zoom'],
];
const NOISE_WORDS = ('alpha bravo cedar delta ember fjord grove harbor island jasper kettle lagoon meadow nectar orchid '
    + 'pebble quarry raven sierra timber umber velvet willow xenon yarrow zephyr amber birch canyon dune').split(' ');

/**
 * One-off work: single tool calls (now and then two unrelated ones), unique
 * mail subjects and unique file names.
 */
function noise(seed, { days = 90, toolsPerDay = 1.5, mailsPerDay = 2, filesPerWeek = 2, pairs = 0.25 } = {}) {
    const r = rng(seed);
    const pick = (list) => list[Math.floor(r() * list.length)];
    const word = () => pick(NOISE_WORDS);
    const out = [];
    let conv = 0;
    let uniq = 1000;
    for (let d = 0; d < days; d++) {
        const nTools = Math.floor(toolsPerDay + r());
        for (let i = 0; i < nTools; i++) {
            const ts = at(d, 8 + Math.floor(r() * 10), Math.floor(r() * 60));
            const steps = [pick(NOISE_TOOLS)];
            if (r() < pairs) steps.push(pick(NOISE_TOOLS));
            out.push(...session(ts, `noise-${seed}-${conv++}`, steps));
        }
        const nMail = Math.floor(mailsPerDay + r());
        for (let i = 0; i < nMail; i++) {
            const subject = `${word()} ${word()} ${word()} ${word()} ${uniq++}`;
            out.push(mailIn(at(d, 7 + Math.floor(r() * 12), Math.floor(r() * 60)), pick(['gmail', 'outlook']), subject, { domain: `dn${uniq}` }));
        }
        if (r() < filesPerWeek / 7) {
            out.push(fileNew(at(d, 10 + Math.floor(r() * 6)), 'nextcloud', `${word()}-${word()}-notes.txt`, `fold-${uniq++}`));
        }
    }
    return out;
}

/**
 * A heavy chat user: many long sessions a day, each a random walk through the
 * noise vocabulary. Every ordered pair shows up often, so only a miner that
 * asks "more than chance?" stays quiet on it.
 */
function heavyUse(seed, { days = 90, perDay = 20, len = 8 } = {}) {
    const r = rng(seed);
    const pick = () => NOISE_TOOLS[Math.floor(r() * NOISE_TOOLS.length)];
    const out = [];
    for (let d = 0; d < days; d++) {
        for (let k = 0; k < perDay; k++) {
            const steps = Array.from({ length: len }, pick);
            out.push(...session(at(d, 8 + Math.floor(r() * 10), Math.floor(r() * 60)), `heavy-${seed}-${d}-${k}`, steps, 1));
        }
    }
    return out;
}

module.exports = { NOW, TODAY, DAY, HOUR, MIN, rng, at, weekdayOf, daysOn, tool, mailIn, mailOut, fileNew, meeting, session, noise, heavyUse };

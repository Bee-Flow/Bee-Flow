/**
 * Google Calendar Tools — Built-in tools for AI to manage calendar events
 * 
 * Injected into the LLM tool set when the user is logged in with Google,
 * allowing the AI to list, search, create, update, and delete calendar events.
 * Create/update/delete actions require user approval before executing.
 */

require('googleapis');
require('../auth/permissions');
const log = require('../telemetry/log');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const CALENDAR_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'calendar_list_events',
            description: 'List upcoming events from the user\'s Google Calendar. By default returns events for the next 7 days. Use this when the user asks about their schedule, upcoming meetings, or what\'s on their calendar.',
            parameters: {
                type: 'object',
                properties: {
                    daysAhead: {
                        type: 'integer',
                        description: 'Number of days ahead to look (1-30, default 7)'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of events to return (1-50, default 20)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'calendar_search_events',
            description: 'Search for calendar events by keyword. Searches event titles and descriptions. Use this when the user asks about a specific meeting or event by name.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search keyword to find in event titles and descriptions'
                    },
                    daysAhead: {
                        type: 'integer',
                        description: 'Number of days ahead to search (1-90, default 30)'
                    },
                    daysBefore: {
                        type: 'integer',
                        description: 'Number of days in the past to search (0-90, default 7)'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of results (1-50, default 20)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'calendar_create_event',
            description: 'Create a new event on the user\'s Google Calendar. The user will see a preview and must approve before the event is created. Requires a title and start time. Use ISO 8601 local time for dates/times (e.g. "2026-03-01T14:00:00") and pass the user\'s IANA timezone in timeZone.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Event title/summary' },
                    startTime: { type: 'string', description: 'Start date/time as ISO 8601 local time, e.g. "2026-03-01T14:00:00". Google Calendar requires a timezone: provide timeZone as well, or include an explicit UTC offset here.' },
                    endTime: { type: 'string', description: 'End date/time in the same format as startTime. If omitted, defaults to 1 hour after start' },
                    timeZone: { type: 'string', description: 'IANA timezone for startTime/endTime, e.g. "Europe/Amsterdam". Use the user\'s timezone from the "Now:" line of the system context.' },
                    description: { type: 'string', description: 'Event description or notes' },
                    location: { type: 'string', description: 'Event location (physical address or virtual meeting link)' },
                    attendees: { type: 'string', description: 'Comma-separated list of attendee email addresses' },
                    allDay: { type: 'boolean', description: 'If true, creates an all-day event. startTime should be just a date (e.g. "2026-03-01")' },
                    addGoogleMeet: { type: 'boolean', description: 'If true, automatically creates a Google Meet video conference link for this event. Default false. Set to true when the user asks for an online meeting, video call, or virtual meeting.' }
                },
                required: ['title', 'startTime']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'calendar_update_event',
            description: 'Update an existing calendar event. The user will see a preview and must approve before the event is updated. Use calendar_list_events or calendar_search_events first to get the event ID. Only provide the fields you want to change.',
            parameters: {
                type: 'object',
                properties: {
                    eventId: { type: 'string', description: 'The event ID from calendar_list_events or calendar_search_events results' },
                    title: { type: 'string', description: 'New event title' },
                    startTime: { type: 'string', description: 'New start date/time as ISO 8601 local time. When changing times, also pass timeZone (the event\'s original timezone is preserved when omitted).' },
                    endTime: { type: 'string', description: 'New end date/time as ISO 8601 local time' },
                    timeZone: { type: 'string', description: 'IANA timezone for the new startTime/endTime, e.g. "Europe/Amsterdam". Omit to keep the event\'s existing timezone.' },
                    description: { type: 'string', description: 'New event description' },
                    location: { type: 'string', description: 'New event location' }
                },
                required: ['eventId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'calendar_delete_event',
            description: 'Delete/cancel a calendar event. The user will see a confirmation and must approve before the event is deleted. Use calendar_list_events or calendar_search_events first to get the event ID.',
            parameters: {
                type: 'object',
                properties: {
                    eventId: { type: 'string', description: 'The event ID from calendar_list_events or calendar_search_events results' },
                    eventTitle: { type: 'string', description: 'The title of the event being deleted (for user confirmation)' }
                },
                required: ['eventId']
            }
        }
    }
];

// ─── Calendar Client ───────────────────────────────────────────

async function createCalendarClient(session) {
    const { createGoogleApiClient } = require('./googleClient');
    return createGoogleApiClient(session, { api: 'calendar', version: 'v3', notConnectedError: 'Not connected to Google — user must log in with Google' });
}

// ─── Format Event ──────────────────────────────────────────────

function formatEvent(event) {
    const start = event.start?.dateTime || event.start?.date || null;
    const end = event.end?.dateTime || event.end?.date || null;
    const isAllDay = !event.start?.dateTime;

    return {
        id: event.id,
        title: event.summary || '(no title)',
        start,
        end,
        allDay: isAllDay,
        location: event.location || null,
        description: event.description || null,
        status: event.status || null,
        organizer: event.organizer?.email || null,
        attendees: (event.attendees || []).map(a => ({
            email: a.email,
            name: a.displayName || null,
            status: a.responseStatus || null,
        })),
        meetLink: event.hangoutLink || event.conferenceData?.entryPoints?.[0]?.uri || null,
    };
}

// ─── Timezone helpers (BFSF-254) ───────────────────────────────

// Google Calendar rejects a bare local dateTime ("Missing time zone definition
// for start time") — every timed start/end needs either an explicit UTC offset
// in the string or a timeZone field.
const DEFAULT_TZ = 'Europe/Amsterdam';

function hasUtcOffset(s) {
    return /(Z|[+-]\d{2}:?\d{2})$/.test(String(s || ''));
}

// Add one hour to a NAIVE local dateTime string without ever crossing into a
// different timezone representation: interpret the wall-clock in UTC, do the
// arithmetic there (day/month/year rollover for free), re-emit without the Z.
function naivePlusOneHour(naive) {
    const d = new Date(`${naive}Z`);
    d.setUTCHours(d.getUTCHours() + 1);
    return d.toISOString().replace(/\.\d{3}Z$/, '');
}

// ─── Tool Execution ────────────────────────────────────────────

// `opts.timezone` carries the requester's IANA timezone from the dispatch
// context (the browser sends it with every chat message); mirrors the
// executeGmailTool(toolName, args, session, opts) 4th-arg pattern.
async function executeCalendarTool(toolName, args, session, opts = {}) {
    const calendar = await createCalendarClient(session);

    if (toolName === 'calendar_list_events') {
        const daysAhead = Math.min(Math.max(parseInt(args.daysAhead) || 7, 1), 30);
        const maxResults = Math.min(Math.max(parseInt(args.maxResults) || 20, 1), 50);

        const now = new Date();
        const future = new Date(now);
        future.setDate(future.getDate() + daysAhead);

        log.info(`[Calendar] Listing events for next ${daysAhead} day(s)`);

        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now.toISOString(),
            timeMax: future.toISOString(),
            maxResults,
            singleEvents: true,
            orderBy: 'startTime',
        });

        const events = (response.data.items || []).map(formatEvent);

        return {
            results: events,
            count: events.length,
            period: `${now.toISOString().split('T')[0]} to ${future.toISOString().split('T')[0]}`,
            message: events.length > 0
                ? `Found ${events.length} event(s) in the next ${daysAhead} day(s).`
                : `No events found in the next ${daysAhead} day(s).`,
        };

    } else if (toolName === 'calendar_search_events') {
        const { query } = args;
        if (!query) return { error: 'query is required' };

        const daysAhead = Math.min(Math.max(parseInt(args.daysAhead) || 30, 1), 90);
        const daysBefore = Math.min(Math.max(parseInt(args.daysBefore) || 7, 0), 90);
        const maxResults = Math.min(Math.max(parseInt(args.maxResults) || 20, 1), 50);

        const now = new Date();
        const past = new Date(now);
        past.setDate(past.getDate() - daysBefore);
        const future = new Date(now);
        future.setDate(future.getDate() + daysAhead);

        log.info(`[Calendar] Searching events: "${query}"`);

        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: past.toISOString(),
            timeMax: future.toISOString(),
            maxResults,
            singleEvents: true,
            orderBy: 'startTime',
            q: query,
        });

        const events = (response.data.items || []).map(formatEvent);

        return {
            results: events,
            count: events.length,
            query,
            message: events.length > 0
                ? `Found ${events.length} event(s) matching "${query}".`
                : `No events found matching "${query}".`,
        };

    } else if (toolName === 'calendar_create_event') {
        const { title, startTime, endTime, timeZone, description, location, attendees, allDay, addGoogleMeet } = args;
        if (!title) return { error: 'title is required' };
        if (!startTime) return { error: 'startTime is required' };

        return {
            _action: 'calendar_draft',
            draft: {
                action: 'create',
                title, startTime,
                endTime: endTime || null,
                // Model-provided zone wins, then the requester's browser zone
                // from the dispatch context, then the org default — so the
                // approval card and the execute step always carry a zone.
                timeZone: timeZone || opts.timezone || DEFAULT_TZ,
                description: description || null,
                location: location || null,
                attendees: attendees || null,
                allDay: allDay || false,
                addGoogleMeet: addGoogleMeet || false,
            },
            message: `Calendar event prepared: "${title}"${addGoogleMeet ? ' (with Google Meet)' : ''}. Waiting for user approval.`,
        };

    } else if (toolName === 'calendar_update_event') {
        const { eventId, title, startTime, endTime, timeZone, description, location } = args;
        if (!eventId) return { error: 'eventId is required' };

        return {
            _action: 'calendar_draft',
            draft: {
                action: 'update',
                eventId,
                title: title || null,
                startTime: startTime || null,
                endTime: endTime || null,
                // Updates deliberately do NOT default: when the model omits
                // the zone, the execute step preserves the event's stored
                // timezone instead of clobbering it with ours.
                timeZone: timeZone || null,
                description: description !== undefined ? description : null,
                location: location !== undefined ? location : null,
            },
            message: `Event update prepared. Waiting for user approval.`,
        };

    } else if (toolName === 'calendar_delete_event') {
        const { eventId, eventTitle } = args;
        if (!eventId) return { error: 'eventId is required' };

        return {
            _action: 'calendar_draft',
            draft: {
                action: 'delete',
                eventId,
                title: eventTitle || eventId,
            },
            message: `Event deletion prepared: "${eventTitle || eventId}". Waiting for user approval.`,
        };

    } else {
        throw new Error(`Unknown Calendar tool: ${toolName}`);
    }
}

// ─── Execute Calendar Action (called from API route after user approval) ──

async function executeCalendarAction(action, session) {
    const calendar = await createCalendarClient(session);

    if (action.action === 'create') {
        const event = { summary: action.title };

        if (action.allDay) {
            const startDate = action.startTime.split('T')[0];
            const endDate = action.endTime ? action.endTime.split('T')[0] : (() => {
                const d = new Date(startDate);
                d.setDate(d.getDate() + 1);
                return d.toISOString().split('T')[0];
            })();
            // Date-only events need no timezone.
            event.start = { date: startDate };
            event.end = { date: endDate };
        } else {
            // BFSF-254: Google requires a timezone for timed events — a bare
            // local dateTime hard-fails with "Missing time zone definition for
            // start time". Always attach timeZone; when the dateTime carries
            // an explicit offset, Google treats the offset as authoritative
            // and uses timeZone for display/recurrence, so setting both is
            // tolerant of model-provided offsets. Legacy drafts persisted in
            // old conversations lack action.timeZone → default.
            const tz = action.timeZone || DEFAULT_TZ;
            event.start = { dateTime: action.startTime, timeZone: tz };
            if (action.endTime) {
                event.end = { dateTime: action.endTime, timeZone: tz };
            } else if (hasUtcOffset(action.startTime)) {
                // Offset-bearing start: the absolute instant is known, so a
                // plain +1h in absolute time is exact.
                const end = new Date(action.startTime);
                end.setHours(end.getHours() + 1);
                event.end = { dateTime: end.toISOString(), timeZone: tz };
            } else {
                // Naive local start: add 1 hour in WALL-CLOCK terms. Mixing a
                // Z-suffixed end with a naive start would shift the event by
                // the UTC offset (the previous behavior, subtly wrong even
                // when creation succeeded).
                event.end = { dateTime: naivePlusOneHour(action.startTime), timeZone: tz };
            }
        }

        if (action.description) event.description = action.description;
        if (action.location) event.location = action.location;
        if (action.attendees) {
            event.attendees = action.attendees.split(',').map(e => ({ email: e.trim() }));
        }

        // Add Google Meet conferencing if requested
        if (action.addGoogleMeet) {
            event.conferenceData = {
                createRequest: {
                    requestId: `meet-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                    conferenceSolutionKey: { type: 'hangoutsMeet' }
                }
            };
        }

        log.info(`[Calendar] Creating event: "${action.title}" at ${action.startTime}${action.addGoogleMeet ? ' (with Meet)' : ''}`);
        const response = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: event,
            sendUpdates: action.attendees ? 'all' : 'none',
            conferenceDataVersion: action.addGoogleMeet ? 1 : 0,
        });

        return {
            id: response.data.id,
            title: response.data.summary,
            start: response.data.start?.dateTime || response.data.start?.date,
            end: response.data.end?.dateTime || response.data.end?.date,
            link: response.data.htmlLink,
            meetLink: response.data.hangoutLink || response.data.conferenceData?.entryPoints?.[0]?.uri || null,
        };

    } else if (action.action === 'update') {
        log.info(`[Calendar] Updating event: ${action.eventId}`);
        const current = await calendar.events.get({ calendarId: 'primary', eventId: action.eventId });
        const updated = { ...current.data };

        if (action.title) updated.summary = action.title;
        // BFSF-254: preserve the event's stored timezone on partial time
        // changes unless the model explicitly supplied a new one; fall back to
        // the default so a naive dateTime never reaches Google bare.
        const updateTz = (which) => action.timeZone || current.data[which]?.timeZone || DEFAULT_TZ;
        if (action.startTime) {
            updated.start = { dateTime: action.startTime, timeZone: updateTz('start') };
        }
        if (action.endTime) {
            updated.end = { dateTime: action.endTime, timeZone: updateTz('end') };
        }
        if (action.description !== null && action.description !== undefined) updated.description = action.description;
        if (action.location !== null && action.location !== undefined) updated.location = action.location;

        const response = await calendar.events.update({
            calendarId: 'primary',
            eventId: action.eventId,
            requestBody: updated,
        });

        return {
            id: response.data.id,
            title: response.data.summary,
            start: response.data.start?.dateTime || response.data.start?.date,
            end: response.data.end?.dateTime || response.data.end?.date,
        };

    } else if (action.action === 'delete') {
        log.info(`[Calendar] Deleting event: ${action.eventId}`);
        await calendar.events.delete({ calendarId: 'primary', eventId: action.eventId });
        return { deleted: true };

    } else {
        throw new Error(`Unknown calendar action: ${action.action}`);
    }
}

function isCalendarTool(toolName) {
    return [
        'calendar_list_events',
        'calendar_search_events',
        'calendar_create_event',
        'calendar_update_event',
        'calendar_delete_event',
    ].includes(toolName);
}

module.exports = {
    CALENDAR_TOOLS,
    executeCalendarTool,
    executeCalendarAction,
    isCalendarTool,
    createCalendarClient,
};

// @typecheck noImplicitAny
/**
 * Microsoft Calendar Tools — Built-in tools for AI to manage Outlook Calendar
 * 
 * Mirror of calendarTools.js for Microsoft 365 users.
 * Uses Microsoft Graph API v1.0 with OAuth2 tokens from session.
 */

const { graphFetch, isMicrosoftConnected } = require('./msGraphClient');
const { MS_CALENDAR_TOOLS } = require('./msCalendarToolsMsCalendarTools');

/**
 * A Graph calendar event, as far as this file reads or writes it.
 * @typedef {{ id?: string, subject?: string, start?: { dateTime?: string, timeZone?: string },
 *   end?: { dateTime?: string, timeZone?: string }, location?: { displayName?: string },
 *   organizer?: { emailAddress?: { address?: string, name?: string } },
 *   attendees?: Array<{ emailAddress?: { address?: string, name?: string }, status?: { response?: string }, type?: string }>,
 *   isOnlineMeeting?: boolean, onlineMeeting?: { joinUrl?: string }, onlineMeetingProvider?: string,
 *   body?: { contentType?: string, content?: string } }} GraphEvent
 * The calendar draft the user approves (built by executeMsCalendarTool, or Graph-shaped JSON posted to the execute route).
 * @typedef {{ eventId?: string, title?: string, startTime?: string, endTime?: string, timeZone?: string,
 *   location?: string | null, description?: string | null, body?: string, attendees?: string | null,
 *   isOnlineMeeting?: boolean }} MsCalendarDraft
 */

/**
 * Format a Graph API event into a consistent shape.
 * @param {GraphEvent} event
 */
function formatEvent(event) {
    return {
        id: event.id,
        subject: event.subject || '(no title)',
        start: event.start?.dateTime || '',
        startTimeZone: event.start?.timeZone || 'UTC',
        end: event.end?.dateTime || '',
        endTimeZone: event.end?.timeZone || 'UTC',
        location: event.location?.displayName || '',
        organizer: event.organizer?.emailAddress?.address || '',
        attendees: (event.attendees || []).map(a => ({
            email: a.emailAddress?.address,
            name: a.emailAddress?.name,
            status: a.status?.response || 'none',
        })),
        isOnlineMeeting: event.isOnlineMeeting || false,
        onlineMeetingUrl: event.onlineMeeting?.joinUrl || '',
        body: event.body?.content ? event.body.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500) : '',
    };
}

/**
 * Execute a Microsoft Calendar tool call.
 * @param {string} toolName
 * @param {{ daysAhead?: number | string, maxResults?: number | string, query?: string, subject?: string, startTime?: string,
 *   endTime?: string, location?: string, body?: string, attendees?: string, isOnlineMeeting?: boolean, timeZone?: string,
 *   eventId?: string }} args
 * @param {Express.Session} session
 */
async function executeMsCalendarTool(toolName, args, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Microsoft Calendar — user must log in with Microsoft');
    }

    if (toolName === 'ms_calendar_list_events') {
        const daysAhead = Math.min(Math.max(parseInt(args.daysAhead) || 7, 1), 90);
        const maxResults = Math.min(Math.max(parseInt(args.maxResults) || 20, 1), 50);

        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + daysAhead);

        const data = await graphFetch(
            `/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$top=${maxResults}&$orderby=start/dateTime&$select=id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeeting,body`,
            session
        );

        return {
            events: (data.value || []).map(formatEvent),
            timeRange: { from: now.toISOString(), to: end.toISOString() },
        };

    } else if (toolName === 'ms_calendar_search_events') {
        const { query } = args;
        if (!query) throw new Error('query is required');

        const daysAhead = Math.min(Math.max(parseInt(args.daysAhead) || 30, 1), 90);
        const now = new Date();
        const end = new Date(now);
        end.setDate(end.getDate() + daysAhead);

        // Use calendarView with $filter for subject search
        const data = await graphFetch(
            `/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$filter=contains(subject,'${query.replace(/'/g, "''")}')&$top=20&$select=id,subject,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeeting,body`,
            session
        );

        return {
            events: (data.value || []).map(formatEvent),
            query,
        };

    } else if (toolName === 'ms_calendar_create_event') {
        const { subject, startTime, endTime, location, body, attendees, isOnlineMeeting, timeZone } = args;
        if (!subject || !startTime || !endTime) throw new Error('subject, startTime, and endTime are required');

        const tz = timeZone || 'UTC';

        const draft = {
            action: 'create',
            _provider: 'microsoft',
            title: subject,
            startTime,
            endTime,
            timeZone: tz,
            location: location || null,
            description: body || null,
            attendees: attendees || null,
            isOnlineMeeting: isOnlineMeeting || false,
        };

        return {
            _action: 'calendar_draft',
            _provider: 'microsoft',
            _calendarAction: 'create',
            draft,
            message: `Calendar event "${subject}" prepared. Waiting for user approval to create.`,
        };

    } else if (toolName === 'ms_calendar_update_event') {
        const { eventId, subject, startTime, endTime, location, body, timeZone } = args;
        if (!eventId) throw new Error('eventId is required');

        /** @type {{ title?: string, startTime?: string, endTime?: string, timeZone?: string, location?: string, description?: string }} */
        const changes = {};
        if (subject) changes.title = subject;
        if (startTime) changes.startTime = startTime;
        if (endTime) changes.endTime = endTime;
        // Deliberately no default: when the model omits the zone, the execute
        // step preserves the event's stored time zone instead of clobbering
        // it with ours (mirrors calendar_update_event, BFSF-254).
        if (timeZone) changes.timeZone = timeZone;
        if (location !== undefined) changes.location = location;
        if (body !== undefined) changes.description = body;

        return {
            _action: 'calendar_draft',
            _provider: 'microsoft',
            _calendarAction: 'update',
            draft: { action: 'update', _provider: 'microsoft', eventId, ...changes },
            message: `Calendar event update prepared. Waiting for user approval.`,
        };

    } else if (toolName === 'ms_calendar_delete_event') {
        const { eventId, subject } = args;
        if (!eventId) throw new Error('eventId is required');

        return {
            _action: 'calendar_draft',
            _provider: 'microsoft',
            _calendarAction: 'delete',
            draft: { action: 'delete', _provider: 'microsoft', eventId, title: subject || 'event' },
            message: `Will delete event "${subject || eventId}". Waiting for user confirmation.`,
        };

    } else {
        throw new Error(`Unknown MS Calendar tool: ${toolName}`);
    }
}

/**
 * Execute an approved MS Calendar action via Graph API.
 * Called after user confirms the draft.
 * @param {string} action
 * @param {MsCalendarDraft} draft
 * @param {Express.Session} session
 */
async function executeMsCalendarAction(action, draft, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Microsoft Calendar');
    }

    if (action === 'create') {
        /** @type {GraphEvent} */
        const event = {
            subject: draft.title,
            start: {
                dateTime: draft.startTime,
                timeZone: draft.timeZone || 'UTC',
            },
            end: {
                dateTime: draft.endTime,
                timeZone: draft.timeZone || 'UTC',
            },
        };

        if (draft.location) {
            event.location = { displayName: draft.location };
        }
        // The draft carries the notes as `description` (that is the key
        // executeMsCalendarTool writes and CalendarDraftCard renders); `body`
        // is only accepted so a caller POSTing Graph-shaped JSON straight at
        // /api/integrations/calendar/execute still gets its notes through.
        const createBody = draft.description !== undefined && draft.description !== null
            ? draft.description
            : draft.body;
        if (createBody) {
            event.body = { contentType: 'Text', content: createBody };
        }
        if (draft.attendees) {
            event.attendees = draft.attendees.split(',').map((/** @type {string} */ e) => ({
                emailAddress: { address: e.trim() },
                type: 'required',
            }));
        }
        if (draft.isOnlineMeeting) {
            event.isOnlineMeeting = true;
            event.onlineMeetingProvider = 'teamsForBusiness';
        }

        const result = await graphFetch('/me/events', session, {
            method: 'POST',
            body: JSON.stringify(event),
        });

        return {
            success: true,
            eventId: result.id,
            subject: result.subject,
            start: result.start?.dateTime,
            message: `Event "${result.subject}" created successfully.`,
        };

    } else if (action === 'update') {
        const { eventId, ...changes } = draft;
        /** @type {GraphEvent} */
        const patch = {};

        if (changes.title) patch.subject = changes.title;

        if (changes.startTime || changes.endTime) {
            // BFSF-254 (Microsoft twin): a reschedule carries a naive wall-clock
            // dateTime, and the update draft normally has no timeZone at all —
            // the tool only sets one when the model is explicit, and the
            // approval card injects the browser zone on CREATE only. Defaulting
            // to 'UTC' here therefore both shifted the meeting by the user's UTC
            // offset and permanently rewrote the event's stored zone, so read
            // the event and keep its zone unless the caller supplied one.
            let storedStartTz = null;
            let storedEndTz = null;
            if (!changes.timeZone) {
                try {
                    const current = await graphFetch(`/me/events/${eventId}?$select=start,end`, session);
                    storedStartTz = current.start?.timeZone || null;
                    storedEndTz = current.end?.timeZone || null;
                } catch (err) {
                    // Do NOT fall back to 'UTC' here. A transient 429/5xx on this
                    // GET followed by a successful PATCH reproduces the exact
                    // BFSF-254 corruption the read was added to prevent: the
                    // meeting shifts by the user's UTC offset and the event's
                    // stored zone is overwritten, with only a log line to show
                    // for it. The Google twin (calendarTools.js:398) likewise
                    // lets its events.get throw and aborts the update, so fail
                    // loudly and leave the event untouched.
                    throw new Error(
                        `Could not read the event's current time zone, so the reschedule was not applied (the time would have been written as UTC and the event's zone overwritten): ${/** @type {Error} */ (err).message}`
                    );
                }
            }
            if (changes.startTime) {
                patch.start = { dateTime: changes.startTime, timeZone: changes.timeZone || storedStartTz || 'UTC' };
            }
            if (changes.endTime) {
                patch.end = { dateTime: changes.endTime, timeZone: changes.timeZone || storedEndTz || 'UTC' };
            }
        }
        if (changes.location !== undefined) {
            patch.location = { displayName: changes.location };
        }
        // Same key mismatch as create: the draft field is `description`.
        const updateBody = changes.description !== undefined ? changes.description : changes.body;
        if (updateBody !== undefined && updateBody !== null) {
            patch.body = { contentType: 'Text', content: updateBody };
        }

        // An empty patch is a no-op Graph happily accepts, after which we used
        // to report "updated successfully" — tell the user nothing changed.
        if (Object.keys(patch).length === 0) {
            throw new Error('No changes to apply — provide at least one of subject, startTime, endTime, location or body');
        }

        const result = await graphFetch(`/me/events/${eventId}`, session, {
            method: 'PATCH',
            body: JSON.stringify(patch),
        });

        return {
            success: true,
            eventId: result.id,
            message: `Event "${result.subject}" updated successfully.`,
        };

    } else if (action === 'delete') {
        await graphFetch(`/me/events/${draft.eventId}`, session, {
            method: 'DELETE',
        });

        return {
            success: true,
            message: `Event "${draft.title || draft.eventId}" deleted successfully.`,
        };

    } else {
        throw new Error(`Unknown MS Calendar action: ${action}`);
    }
}

/**
 * Check if a tool name is an MS Calendar tool.
 * @param {string} toolName
 */
function isMsCalendarTool(toolName) {
    return ['ms_calendar_list_events', 'ms_calendar_search_events', 'ms_calendar_create_event', 'ms_calendar_update_event', 'ms_calendar_delete_event'].includes(toolName);
}

module.exports = {
    MS_CALENDAR_TOOLS,
    executeMsCalendarTool,
    executeMsCalendarAction,
    isMsCalendarTool,
};

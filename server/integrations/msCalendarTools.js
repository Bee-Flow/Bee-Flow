/**
 * Microsoft Calendar Tools — Built-in tools for AI to manage Outlook Calendar
 * 
 * Mirror of calendarTools.js for Microsoft 365 users.
 * Uses Microsoft Graph API v1.0 with OAuth2 tokens from session.
 */

const { graphFetch, isMicrosoftConnected } = require('./msGraphClient');

/**
 * Tool definitions in OpenAI function-calling format.
 */
const MS_CALENDAR_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'ms_calendar_list_events',
            description: 'List upcoming events from the user\'s Outlook calendar. Returns events from now until the specified number of days ahead.',
            parameters: {
                type: 'object',
                properties: {
                    daysAhead: {
                        type: 'integer',
                        description: 'Number of days ahead to look (default 7, max 90)'
                    },
                    maxResults: {
                        type: 'integer',
                        description: 'Maximum number of events to return (default 20, max 50)'
                    }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_calendar_search_events',
            description: 'Search for events in the user\'s Outlook calendar by subject or content. Returns matching events within the specified timeframe.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query to match against event subjects and body content'
                    },
                    daysAhead: {
                        type: 'integer',
                        description: 'Number of days ahead to search (default 30, max 90)'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_calendar_create_event',
            description: 'Create a new event on the user\'s Outlook calendar. The user will see a preview before it is created. Always use ISO 8601 format for dates/times (e.g. "2025-03-15T10:00:00").',
            parameters: {
                type: 'object',
                properties: {
                    subject: {
                        type: 'string',
                        description: 'Event title/subject'
                    },
                    startTime: {
                        type: 'string',
                        description: 'Start date/time in ISO 8601 format (e.g. "2025-03-15T10:00:00")'
                    },
                    endTime: {
                        type: 'string',
                        description: 'End date/time in ISO 8601 format (e.g. "2025-03-15T11:00:00")'
                    },
                    location: {
                        type: 'string',
                        description: 'Optional: Event location'
                    },
                    body: {
                        type: 'string',
                        description: 'Optional: Event description/notes'
                    },
                    attendees: {
                        type: 'string',
                        description: 'Optional: Comma-separated email addresses of attendees'
                    },
                    isOnlineMeeting: {
                        type: 'boolean',
                        description: 'Optional: Whether to add a Teams meeting link (default false)'
                    },
                    timeZone: {
                        type: 'string',
                        description: 'Optional: Time zone (default "UTC", e.g. "Europe/Amsterdam", "America/New_York")'
                    }
                },
                required: ['subject', 'startTime', 'endTime']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_calendar_update_event',
            description: 'Update an existing event on the user\'s Outlook calendar. The user will see a preview of the changes before they are applied. Only include the fields you want to change.',
            parameters: {
                type: 'object',
                properties: {
                    eventId: {
                        type: 'string',
                        description: 'The event ID to update (from ms_calendar_list_events or ms_calendar_search_events)'
                    },
                    subject: {
                        type: 'string',
                        description: 'New event title'
                    },
                    startTime: {
                        type: 'string',
                        description: 'New start date/time in ISO 8601 format. When changing times, also pass timeZone (the event\'s original time zone is preserved when omitted).'
                    },
                    endTime: {
                        type: 'string',
                        description: 'New end date/time in ISO 8601 format'
                    },
                    timeZone: {
                        type: 'string',
                        description: 'IANA time zone for the new startTime/endTime, e.g. "Europe/Amsterdam". Omit to keep the event\'s existing time zone.'
                    },
                    location: {
                        type: 'string',
                        description: 'New event location'
                    },
                    body: {
                        type: 'string',
                        description: 'New event description'
                    }
                },
                required: ['eventId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'ms_calendar_delete_event',
            description: 'Delete an event from the user\'s Outlook calendar. The user will be asked to confirm before the event is deleted.',
            parameters: {
                type: 'object',
                properties: {
                    eventId: {
                        type: 'string',
                        description: 'The event ID to delete (from ms_calendar_list_events or ms_calendar_search_events)'
                    },
                    subject: {
                        type: 'string',
                        description: 'The event subject (for user confirmation display)'
                    }
                },
                required: ['eventId']
            }
        }
    }
];

/**
 * Format a Graph API event into a consistent shape.
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
 */
async function executeMsCalendarAction(action, draft, session) {
    if (!isMicrosoftConnected(session)) {
        throw new Error('Not connected to Microsoft Calendar');
    }

    if (action === 'create') {
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
            event.attendees = draft.attendees.split(',').map(e => ({
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
                        `Could not read the event's current time zone, so the reschedule was not applied (the time would have been written as UTC and the event's zone overwritten): ${err.message}`
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

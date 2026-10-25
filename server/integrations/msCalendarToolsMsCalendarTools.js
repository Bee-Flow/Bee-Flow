// @typecheck strict

/**
 * Tool definitions in OpenAI function-calling format.
 */
/** @type {Array<{ type: string, function: { name: string, description: string, parameters: { type: string, properties: Record<string, object>, required: string[] } } }>} */
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

module.exports = { MS_CALENDAR_TOOLS };

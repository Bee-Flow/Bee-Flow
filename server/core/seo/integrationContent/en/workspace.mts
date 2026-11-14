/**
 * English text of the integration pages for Google Workspace and Microsoft 365 (see index.mts).
 */

import type { Prose } from '../types.mts';
import { GOOGLE_CONNECT, MS_CONNECT, PREVIEW } from './shared.mts';

export const WORKSPACE: Record<string, Prose> = {
    gmail: {
        title: 'Gmail integration: search, draft and sort mail',
        description: 'Let a Bee Flow assistant search and read Gmail, write drafts and replies, and sort mail with labels. Automations can start on new mail.',
        summary: 'Search and read mail, write drafts and replies, sort with labels.',
        intro: ['With the Gmail integration an assistant works in your own mailbox. It searches with the same search syntax as Gmail itself, reads messages and the text of attachments, writes drafts and replies, and keeps the inbox in order with labels.'],
        groups: {
            find: 'Search the mailbox with Gmail search syntax, read one message or up to 100 at once, and read the text of attachments: PDF, Word, Excel, CSV and images through text recognition.',
            write: 'Write a new message or a reply. In a chat you see a preview with Send, Save as draft and Discard before anything leaves. A draft is saved in Drafts for you to send. A direct reply in the same thread is only offered in a run that a new email started.',
            sort: 'List labels and add or remove them, mark mail read or unread, archive it or move it to the trash, which can be undone. In an automation up to 1,000 messages can be changed in one request.',
        },
        connect: [GOOGLE_CONNECT],
        limits: [
            'Google\'s own quotas apply per mailbox. When Google reports a rate limit, Bee Flow waits and tries again; a request that sends mail is never repeated.',
            'Message bodies and attachments pass through the Privacy Shield before the model sees them.',
        ],
        examples: ['Find last week\'s invoices and list the amounts.', 'Write a draft reply to the latest message from this sender.', 'Label every newsletter from this month and archive them.'],
    },
    'google-calendar': {
        title: 'Google Calendar integration for AI assistants',
        description: 'A Bee Flow assistant reads your Google Calendar, finds meetings and creates, moves or cancels events after you approve. Automations start on changes.',
        summary: 'List and search events; create, change and cancel them after approval.',
        name: 'Google Calendar',
        intro: ['The Google Calendar integration lets an assistant answer questions about your schedule and plan for you. It lists the coming days, finds a meeting by a word in its title or description, and prepares new events or changes.'],
        groups: {
            read: 'List upcoming events (the next seven days unless asked otherwise) and search events by keyword in title and description.',
            change: `Create, update and delete events. ${PREVIEW}`,
        },
        connect: [GOOGLE_CONNECT],
        limits: ['The assistant works in the calendars of the connected account only.', 'Event descriptions pass through the Privacy Shield.'],
        examples: ['What is on my calendar on Thursday?', 'Move the project review to Friday at 10:00.'],
    },
    'google-drive': {
        title: 'Google Drive integration: find and read files',
        description: 'A Bee Flow assistant searches Google Drive, reads Docs, Sheets, PDFs and text files, and moves, uploads and files them in folders.',
        summary: 'Search and read files, upload, move and create folders.',
        intro: ['With Google Drive connected, an assistant finds files by name, type or date, reads their content and puts new files where they belong. Google Docs are read as text and Google Sheets as CSV, so the model can work with them directly.'],
        groups: {
            find: 'Search with Drive search operators, list a folder, list what changed since a date, and read a file\'s details such as size and sharing.',
            read: 'Read the text of a Google Doc, a Google Sheet (as CSV), a PDF or a plain-text file.',
            organise: 'Move a file to another folder, create folders and upload files, for example an attachment taken from an email.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['File content passes through the Privacy Shield before the model sees it.', 'A spreadsheet in Drive can also be linked as a live datatable in Bee Flow.'],
        examples: ['Find the latest version of the price list and summarise it.', 'Save this attachment in the Contracts folder.'],
    },
    'google-slides': {
        title: 'Google Slides integration: read and fill decks',
        description: 'A Bee Flow assistant reads Google Slides decks, fills templates by replacing placeholders, creates blank decks and exports them as PDF.',
        summary: 'Read decks, fill placeholders, create decks, export to PDF.',
        intro: ['The Google Slides integration reads the text of every slide in a presentation and fills templates. A deck with placeholders such as {{NAME}} becomes a finished deck in one step.'],
        groups: {
            read: 'List the presentations you can open and read a deck slide by slide, for a summary or as input for an AI step.',
            make: 'Create a new blank presentation and replace text across a whole deck.',
            export: 'Export a presentation as a PDF download link.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Slides are read as text: images and layout are not described.'],
    },
    'google-sheets': {
        title: 'Google Sheets integration: read and add rows',
        description: 'A Bee Flow assistant reads ranges from Google Sheets, adds rows, overwrites cells and creates new spreadsheets. Automations can start on edits.',
        summary: 'Read ranges, append rows, update cells, create spreadsheets.',
        intro: ['With Google Sheets connected, an assistant reads a tab or a range, adds rows at the end and updates cells. Automations use it to log results or to pick up new rows.'],
        groups: {
            read: 'Find a spreadsheet, list its tabs and read a range as rows and columns.',
            write: 'Append rows, overwrite a range of cells and create a new spreadsheet, optionally with named tabs.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['A spreadsheet can also be linked as a live datatable in Bee Flow.'],
        examples: ['Add a row with today\'s figures to the weekly report.', 'Which rows in the Leads tab have no owner yet?'],
    },
    'google-docs': {
        title: 'Google Docs integration: read and write docs',
        description: 'A Bee Flow assistant reads Google Docs, including documents with tabs, creates new documents, adds text and fills templates by find and replace.',
        summary: 'Read documents, create new ones, append text, fill templates.',
        intro: ['The Google Docs integration reads the text of a document, every tab included, and writes to it. Replacing placeholders makes it a simple way to fill a template.'],
        groups: {
            read: 'Read the text of a document; a document with several tabs comes back per tab, or one tab by name.',
            write: 'Create a document, append text at the end, and find and replace text.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Text only: formatting and images are not read.', 'Document content passes through the Privacy Shield.'],
    },
    'google-contacts': {
        title: 'Google Contacts integration for AI assistants',
        description: 'A Bee Flow assistant searches your Google Contacts by name, email or phone and adds or updates contacts after you approve.',
        summary: 'Search and list contacts; create and update them after approval.',
        name: 'Google Contacts',
        intro: ['With Google Contacts connected, an assistant looks up a person by name, email address or phone number and keeps details up to date.'],
        groups: {
            find: 'Search contacts by name, email or phone, and list them sorted by name.',
            change: `Create a contact or update one. ${PREVIEW}`,
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Contact details are what the Privacy Shield replaces with placeholders before the model sees them.'],
    },
    'google-keep': {
        title: 'Google Keep integration: notes and checklists',
        description: 'A Bee Flow assistant lists and reads your Google Keep notes and creates text notes or checklists after you approve. Automations can start on new notes.',
        summary: 'Read notes; create text notes and checklists, delete notes.',
        intro: ['The Google Keep integration lets an assistant read your notes and add new ones, as plain text or as a checklist.'],
        groups: {
            read: 'List notes with a preview of their content and read a note in full.',
            change: `Create a text note or a checklist, and move a note to the trash. ${PREVIEW}`,
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Notes only: reminders are not part of Keep.'],
    },
    'google-groups': {
        title: 'Google Groups integration: read and reply',
        description: 'A Bee Flow assistant reads the conversations of a Google Group through your Gmail and drafts replies to the group that you review before sending.',
        summary: 'Read group conversations and reply to the group after review.',
        intro: ['The Google Groups integration reads a group\'s conversations from the messages in your own Gmail and can answer in the thread, so the reply reaches every member.'],
        groups: {
            read: 'List recent conversations of a group, filtered by keywords, and read a whole thread in order.',
            reply: 'Reply to a conversation at the group\'s address. You see a preview with Send, Save as draft and Discard first.',
        },
        connect: [GOOGLE_CONNECT],
        limits: ['Reads only the group mail that reached your own mailbox.'],
    },
    maps: {
        title: 'Google Maps integration: places and routes',
        description: 'A Bee Flow assistant searches Google Maps for places near a location and plans routes with travel time, distance and a map link.',
        summary: 'Find places nearby and plan a route with travel time.',
        intro: ['With Google Maps an assistant finds businesses and places near a location and works out how to get from A to B.'],
        groups: {
            places: 'Search places near a location, with address, rating and a map link.',
            route: 'Get directions step by step, with total duration, distance and a map of the route.',
        },
        connect: ['An administrator sets a Google Maps API key for the whole server. People do not connect an account of their own.'],
        limits: ['Google charges the owner of the key for each call.'],
        examples: ['How long does it take from the office to the station at 17:00?'],
    },
    outlook: {
        title: 'Outlook integration: search, read and send mail',
        description: 'A Bee Flow assistant searches and reads Outlook mail, writes drafts and sends mail and replies. Automations can start on new or flagged mail.',
        summary: 'Search and read mail, write drafts, send mail and replies.',
        intro: ['The Outlook integration gives an assistant your Microsoft 365 mailbox: searching with keywords or KQL, reading many messages at once, saving drafts and sending mail.'],
        groups: {
            find: 'Search the mailbox, list the newest messages and read one message or up to 100 at once.',
            write: 'Save a draft for you to send, or send a new message or reply. In a chat you see a preview with Send and Discard first; in an unattended run such as an automation the message is sent directly. A reply in the same conversation is only offered in a run that a new email started.',
        },
        connect: [MS_CONNECT],
        limits: [
            'When Microsoft throttles a request, Bee Flow waits as long as Microsoft asks and tries again. A request that sends mail is not repeated after a server error.',
            'The mail events are pushed by Microsoft, so they need a Bee Flow server that Microsoft can reach.',
        ],
        examples: ['Which emails from this week still need an answer?', 'Draft a reply that confirms the appointment.'],
    },
    'outlook-readonly': {
        title: 'Outlook read-only integration for assistants',
        description: 'A read-only Outlook integration for Bee Flow: the assistant searches and reads mail but cannot write, send or change anything in the mailbox.',
        summary: 'Search and read Outlook mail. Nothing is written or sent.',
        name: 'Outlook (read-only)',
        intro: ['This variant of the Outlook integration only reads. It exists for organisations that want a strictly read-only mailbox connection next to, or instead of, the full one.'],
        groups: {
            find: 'Search the mailbox, list the newest messages and read one message or up to 100 at once.',
        },
        connect: [MS_CONNECT],
        limits: ['Read-only: there is no tool to write, send, move or delete mail.'],
    },
    'ms-calendar': {
        title: 'Outlook Calendar integration for AI assistants',
        description: 'A Bee Flow assistant reads your Microsoft 365 calendar, finds events by subject and creates, changes or deletes events after a preview.',
        summary: 'List and search events; create, change and delete them after a preview.',
        name: 'Microsoft 365 Calendar',
        intro: ['The Microsoft 365 calendar integration answers questions about your Outlook calendar and plans for you: it lists what is coming, finds events by subject or content and prepares new events or changes.'],
        groups: {
            read: 'List events from now until a number of days ahead, and search events by subject or content.',
            change: 'Create, update and delete events. You see a preview of a new event or a change, and confirm a deletion.',
        },
        connect: [MS_CONNECT],
        limits: ['The calendar events are pushed by Microsoft, so they need a Bee Flow server that Microsoft can reach.'],
    },
    onedrive: {
        title: 'OneDrive integration: find files and folders',
        description: 'A Bee Flow assistant searches your OneDrive by name or content, lists folders and recent changes, and creates folders. Automations can start on new files.',
        summary: 'Search files, list folders and recent changes, create folders.',
        intro: ['With OneDrive connected, an assistant finds files by name or content, shows what changed recently and keeps folders in order.'],
        groups: {
            find: 'Search files, list a folder, list what changed since a date and read a file\'s details, such as size and sharing.',
            organise: 'Create a folder.',
        },
        connect: [MS_CONNECT],
        limits: ['The file events are pushed by Microsoft, so they need a Bee Flow server that Microsoft can reach.', 'An Excel or CSV file in OneDrive can also be linked as a live datatable in Bee Flow.'],
    },
    'ms-contacts': {
        title: 'Microsoft Contacts integration for assistants',
        description: 'A Bee Flow assistant searches your Microsoft 365 contacts by name or email and adds or updates contacts after a preview.',
        summary: 'Search and list contacts; create and update them after a preview.',
        name: 'Microsoft 365 Contacts',
        intro: ['The Microsoft 365 contacts integration looks up people in your Outlook contacts and keeps their details current.'],
        groups: {
            find: 'Search contacts by name or email address, and list them with email, phone and company.',
            change: 'Create a contact or update one. You see a preview before anything is saved.',
        },
        connect: [MS_CONNECT],
        limits: ['Contact details pass through the Privacy Shield.'],
    },
};

/**
 * Tool definitions (OpenAI function-calling format) of the Nextcloud Contacts tools.
 * Pure data: the executor is nextcloudContactsTools.js.
 */

export const NEXTCLOUD_CONTACTS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_list_addressbooks',
            description: 'List the user\'s Nextcloud address books.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_list',
            description: 'List contacts from a Nextcloud address book.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string', description: 'Address book slug (from list_addressbooks). Defaults to "contacts".' },
                    limit: { type: 'integer', description: 'Maximum number of contacts (default 200, max 1000).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_search',
            description: 'Search contacts by case-insensitive substring match against name, email, phone, organisation. Searches all address books unless one is specified.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Search term (case-insensitive substring).' },
                    addressbook: { type: 'string', description: 'Optional address book slug to limit search.' },
                    limit: { type: 'integer', description: 'Max results (default 50, max 200).' }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_get',
            description: 'Get a single contact by its uid.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string', description: 'Address book slug.' },
                    uid: { type: 'string', description: 'Contact UID (from list/search).' }
                },
                required: ['addressbook', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_create',
            description: 'Create a new contact. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string', description: 'Address book slug (e.g. "contacts").' },
                    fullName: { type: 'string', description: 'Full / display name (required).' },
                    firstName: { type: 'string' },
                    lastName: { type: 'string' },
                    emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses.' },
                    phones: { type: 'array', items: { type: 'string' }, description: 'Phone numbers.' },
                    organization: { type: 'string', description: 'Organisation / company.' },
                    title: { type: 'string', description: 'Job title.' },
                    notes: { type: 'string' }
                },
                required: ['addressbook', 'fullName']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_update',
            description: 'Update fields on an existing contact. Only provided fields are changed; omitted fields are preserved. The user has approved this.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string' },
                    uid: { type: 'string' },
                    fullName: { type: 'string' },
                    firstName: { type: 'string' },
                    lastName: { type: 'string' },
                    emails: { type: 'array', items: { type: 'string' } },
                    phones: { type: 'array', items: { type: 'string' } },
                    organization: { type: 'string' },
                    title: { type: 'string' },
                    notes: { type: 'string' }
                },
                required: ['addressbook', 'uid']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_contacts_delete',
            description: 'Delete a contact. Always confirm with the user before calling this.',
            parameters: {
                type: 'object',
                properties: {
                    addressbook: { type: 'string' },
                    uid: { type: 'string' }
                },
                required: ['addressbook', 'uid']
            }
        }
    }
];

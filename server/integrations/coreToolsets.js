/**
 * The integration tool arrays and helpers getIntegrationTools hands to its tool
 * groups (core/integrations/integrationTools.js). Core may not require a
 * feature, so core asks for this module by name (boot/featureModules.js,
 * core/featureModules.js) and gets the toolsets and the feature-side
 * collaborators from here.
 */

'use strict';

const { GMAIL_TOOLS } = require('./gmailTools');
const { CALENDAR_TOOLS } = require('./calendarTools');
const { DRIVE_TOOLS } = require('./driveTools');
const { DOCS_TOOLS } = require('./docsTools');
const { SHEETS_TOOLS } = require('./sheetsTools');
const { SLIDES_TOOLS } = require('./slidesTools');
const { CONTACTS_TOOLS } = require('./contactsTools');
const { KEEP_TOOLS } = require('./keepTools');
const { GOOGLE_GROUPS_TOOLS } = require('./googleGroupsTools');
const { FIREFLIES_TOOLS } = require('./firefliesTools');
const { YOUTRACK_TOOLS } = require('./youtrackTools');
const { SIGNREQUEST_TOOLS } = require('./signrequestTools');
const { GAMMA_TOOLS } = require('./gammaTools');
const { AFAS_TOOLS } = require('./afasTools');
const { NMBRS_TOOLS } = require('./nmbrsTools');
const { VPLAN_TOOLS } = require('./vplanTools');
const { SCALEWAY_BILLING_TOOLS } = require('./scalewayBillingTools');
const { buildN8nTools } = require('./n8nTools');
const { N8N_WORKFLOW_TOOLS, getN8nToolPermission } = require('./n8nWorkflowTools');
const { AGENT_SEARCH_TOOLS } = require('./agentSearchTools');
const { BROWSE_WEB_TOOLS } = require('./browserFetchTools');
const { REGEX_GENERATOR_TOOLS } = require('./regexGeneratorTools');
const { WORKSPACE_TOOLS } = require('./workspaceTools');
const { KB_SEARCH_TOOLS } = require('./kbSearchTools');
const { KB_INGEST_TOOLS } = require('./kbIngestTools');
const { MAPS_TOOLS } = require('./mapsTools');
const { LINKEDIN_TOOLS } = require('./linkedinTools');
const { WITHINGS_TOOLS } = require('./withingsTools');
const { GITHUB_TOOLS } = require('./githubTools');
const { OUTLOOK_TOOLS, OUTLOOK_READONLY_TOOLS } = require('./outlookTools');
const { MS_CALENDAR_TOOLS } = require('./msCalendarTools');
const { ONEDRIVE_TOOLS } = require('./oneDriveTools');
const { MS_CONTACTS_TOOLS } = require('./msContactsTools');
const { TRANSCRIPTION_TOOLS } = require('./transcriptionTools');
const { NEXTCLOUD_TOOLS } = require('./nextcloudTools');
const { NEXTCLOUD_CALENDAR_TOOLS } = require('./nextcloudCalendarTools');
const { NEXTCLOUD_CONTACTS_TOOLS } = require('./nextcloudContactsTools');
const { NEXTCLOUD_DECK_TOOLS } = require('./nextcloudDeckTools');
const { NEXTCLOUD_NOTIFICATIONS_TOOLS } = require('./nextcloudNotificationsTools');
const { NEXTCLOUD_TALK_TOOLS } = require('./nextcloudTalkTools');
const { NEXTCLOUD_TASKS_TOOLS } = require('./nextcloudTasksTools');
const { NEXTCLOUD_NOTES_TOOLS } = require('./nextcloudNotesTools');
const { NEXTCLOUD_MAIL_TOOLS } = require('./nextcloudMailTools');
const { NEXTCLOUD_ACTIVITY_TOOLS } = require('./nextcloudActivityTools');
const { NEXTCLOUD_TABLES_TOOLS } = require('./nextcloudTablesTools');
const { NEXTCLOUD_FORMS_TOOLS } = require('./nextcloudFormsTools');
const { NEXTCLOUD_TEAMS_TOOLS } = require('./nextcloudTeamsTools');
const { NEXTCLOUD_STATUS_TOOLS } = require('./nextcloudStatusTools');
const { WEBPAGE_AUTOMATION_TOOLS } = require('./webpageAutomationTools');

const TOOLSETS = {
    GMAIL_TOOLS,
    CALENDAR_TOOLS,
    DRIVE_TOOLS,
    DOCS_TOOLS,
    SHEETS_TOOLS,
    SLIDES_TOOLS,
    CONTACTS_TOOLS,
    KEEP_TOOLS,
    GOOGLE_GROUPS_TOOLS,
    FIREFLIES_TOOLS,
    YOUTRACK_TOOLS,
    SIGNREQUEST_TOOLS,
    GAMMA_TOOLS,
    AFAS_TOOLS,
    NMBRS_TOOLS,
    VPLAN_TOOLS,
    SCALEWAY_BILLING_TOOLS,
    N8N_WORKFLOW_TOOLS,
    AGENT_SEARCH_TOOLS,
    BROWSE_WEB_TOOLS,
    REGEX_GENERATOR_TOOLS,
    WORKSPACE_TOOLS,
    KB_SEARCH_TOOLS,
    KB_INGEST_TOOLS,
    MAPS_TOOLS,
    LINKEDIN_TOOLS,
    WITHINGS_TOOLS,
    GITHUB_TOOLS,
    OUTLOOK_TOOLS,
    OUTLOOK_READONLY_TOOLS,
    MS_CALENDAR_TOOLS,
    ONEDRIVE_TOOLS,
    MS_CONTACTS_TOOLS,
    TRANSCRIPTION_TOOLS,
    NEXTCLOUD_TOOLS,
    NEXTCLOUD_CALENDAR_TOOLS,
    NEXTCLOUD_CONTACTS_TOOLS,
    NEXTCLOUD_DECK_TOOLS,
    NEXTCLOUD_NOTIFICATIONS_TOOLS,
    NEXTCLOUD_TALK_TOOLS,
    NEXTCLOUD_TASKS_TOOLS,
    NEXTCLOUD_NOTES_TOOLS,
    NEXTCLOUD_MAIL_TOOLS,
    NEXTCLOUD_ACTIVITY_TOOLS,
    NEXTCLOUD_TABLES_TOOLS,
    NEXTCLOUD_FORMS_TOOLS,
    NEXTCLOUD_TEAMS_TOOLS,
    NEXTCLOUD_STATUS_TOOLS,
    WEBPAGE_AUTOMATION_TOOLS,
};

/** The feature-side entries of integrationTools' GROUP_DEPS (lazy ones stay lazy). */
const GROUP_DEPS = {
    buildN8nTools, N8N_WORKFLOW_TOOLS, getN8nToolPermission,
    webSearchAvailability: () => require('./webSearchAvailability'),
    officeFileDelivery: () => require('./officeFileDelivery'),
    memoryTools: () => require('./memoryTools'),
    automationEvolutionTools: () => require('./automationEvolutionToolDefs'),
    nextcloudClient: () => require('./nextcloudClient'),
};

module.exports = { TOOLSETS, GROUP_DEPS };

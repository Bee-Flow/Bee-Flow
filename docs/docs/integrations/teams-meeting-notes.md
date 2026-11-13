---
title: Teams meeting notes setup
description: How to set up Microsoft Teams meeting notes in Bee Flow, who does what in Bee Flow, Microsoft Entra and Teams, the two supported ways (per organiser and organisation-wide), the built-in tests and what every test result means.
---

# Teams meeting notes setup

Bee Flow turns Microsoft Teams meetings into Meeting Notes: it reads the meeting's recording (or,
when there is none, its Teams transcript) through Microsoft Graph and runs it through your own
transcription and summary pipeline. No bot joins the call. How the import works once it is set up
is described on the [Microsoft 365 page](./microsoft.md#microsoft-teams-meeting-notes); this page is
about getting there and about the tests that tell you what is still missing.

Meeting Notes needs a licence that includes the `meeting_notes` feature (see
[Licensing](../licensing/tiers.md)), and the Meeting Notes module switched on.

## Two supported ways

| | A. Per organiser (delegated) | B. Organisation-wide (application) |
|---|---|---|
| What is imported | The meetings each connected organiser organises | The meetings of the members an organisation admin covers, without each of them connecting |
| Token | The organiser's own Microsoft 365 connection | An app token of the Bee Flow app registration, for one Microsoft tenant |
| Microsoft side | Delegated permissions, admin consent for the recording and transcript permissions | Application permissions with admin consent, plus a Teams application access policy |
| Default | The way Bee Flow works out of the box | Off; an organisation admin switches it on |

Both can run side by side. A member with a usable connection of their own is always imported with
that connection (option A); the app token is used only for covered members without one.

## Who does what

| Role | Where | Does |
|---|---|---|
| Bee Flow platform administrator | Admin, Security, SSO, Microsoft | Enters the app registration (client ID, secret, tenant), tests it, and for option B links the organisation to its Microsoft tenant |
| Organisation admin in Bee Flow | Settings, Organisation, Meeting Templates, in the **Microsoft Teams Meeting Notes** block | Reads the setup guide, makes the admin consent link, sees which members are ready, sets automatic import for everyone, and switches option B on |
| Microsoft Entra administrator | Microsoft Entra admin center | Adds the permissions to the app registration and grants admin consent |
| Microsoft Teams administrator | Teams admin center or Teams PowerShell | Allows recording and transcription, the transcript API switches and, for option B, the application access policy |
| Each organiser | Settings, Connections; Settings, Preferences; Meeting Notes, Upcoming | Connects Microsoft 365 (option A), tests the connection, picks which meetings to import |

The SSO settings, and with them the Microsoft tab, need the `sso_saml` licence feature. The
Meeting Templates page shows only to organisation admins of an organisation whose plan includes
Meeting Notes.

## What to ask your administrators

For an organisation admin who has no rights in Microsoft Entra or Teams. Run the tests in Settings,
Organisation, Meeting Templates first: every check that fails names who can fix it. Then send each
administrator the part below that the tests point to.

You need two values. The **Application (client) ID** of the Bee Flow app registration: the platform
administrator has it, and it is the `client_id=` part of the admin consent link. The **admin
consent link** itself: make it with **Make the link** in the Microsoft Teams Meeting Notes block.

**To your Microsoft Entra administrator, for option A.** They need one of these roles: Cloud
Application Administrator, Application Administrator, AI Administrator or Privileged Role
Administrator.

- Grant tenant-wide admin consent to the Bee Flow app registration (the client ID above) for the
  Microsoft Graph delegated permissions `OnlineMeetingRecording.Read.All` (required) and
  `OnlineMeetingTranscript.Read.All` (optional, for meetings that have only a transcript). Either
  open the admin consent link, or select **Grant admin consent** under API permissions of the app
  registration, or under Enterprise apps, the app, **Permissions**.
- When the app registration is in your own tenant and a test reports `permission_not_on_app`: add
  the missing permission under API permissions first (see the
  [delegated permissions](#2-add-the-delegated-permissions)). When the app registration is in
  another tenant, your Entra administrator can only consent to what it lists; a missing permission
  is then for the platform administrator.
- Only when a test reports it: assign the members, or a group, to the enterprise application
  (`user_not_assigned`), check the Conditional Access policy that blocked the request
  (`blocked_by_conditional_access`), or enable sign-in for the enterprise application
  (`app_disabled`).

**To your Microsoft Teams administrator.**

- Allow cloud recording in the meeting policy of the organisers (`AllowCloudRecording`), and
  transcription if transcripts are wanted (`AllowTranscription`).
- For transcripts: switch on **Transcript API access** and **Include speaker attribution** under
  Meetings, Meeting settings. Recordings work without these. The commands are in
  [Teams settings](#4-teams-settings).

**For option B, in addition.**

- Microsoft Entra: add the four [application permissions](#1-application-permissions) to the app
  registration, and have a **Privileged Role Administrator** grant admin consent. The other roles
  cannot approve application permissions for Microsoft Graph. The same admin consent link works.
- Microsoft Teams: create an application access policy for the client ID and grant it to the
  covered members or to the whole tenant ([commands](#2-teams-application-access-policy)).
- Exchange, optional: when the app may read only some calendars, an application access policy for
  mailboxes that includes every covered member.
- Not Microsoft but the Bee Flow platform administrator: link your organisation to its Microsoft
  tenant ([step 3](#3-link-the-organisation-to-its-tenant)).

## Option A: per organiser

### 1. Register the app

1. In the [Microsoft Entra admin center](https://entra.microsoft.com), under **App registrations**,
   create a registration. Bee Flow uses one registration for signing in with Microsoft, connecting
   Microsoft 365 and Teams meeting notes, so if you already set one up for sign-in, use that one.
2. Under **Authentication**, add both addresses as **Web** redirect URIs, exactly as written, with
   your own Bee Flow address:
   - Sign-in: `https://your-host/auth/callback/microsoft`
   - Connecting Microsoft 365, and the admin consent link: `https://your-host/api/integrations/microsoft/callback`

   The setup guide in Settings, Organisation, Meeting Templates shows both addresses as your
   server builds them.
3. Under **Certificates & secrets**, create a client secret. Copy its **Value**, not the Secret ID.
4. In Bee Flow, a platform administrator opens **Admin, Security, SSO, Microsoft** and fills in the
   **Application (client) ID**, the client secret value and the **Directory (tenant) ID**. Leave
   the tenant empty (or `common`) for a multi-tenant app, or use `organizations`. `consumers` does
   not work for Teams: recordings need work or school accounts. Bee Flow keeps these values in its
   own database; there are no environment variables for them.
5. Press the test button on that tab. Bee Flow asks Microsoft for a token with the stored client ID
   and secret (a client-credentials request that needs no permission), which proves that the app,
   the secret and the tenant are right. With the tenant set to `common` or `organizations`, the test
   uses the tenant of your own Microsoft sign-in; without one it says so (`tenant_needed`).
   Bee Flow cannot read the registered redirect URIs from Microsoft, so the test lists them for you
   to check (`manual_check`).

### 2. Add the delegated permissions

Bee Flow asks for one set of Microsoft Graph delegated permissions at sign-in, and four more when a
member connects Microsoft 365 (the shared-mailbox and mail-write permissions). Add every one of them
under **API permissions** in the app registration: admin consent, and the admin consent link below,
approve what the registration lists.

| Permission | Teams meeting notes | Admin consent | Used for |
|---|---|:---:|---|
| `openid`, `email`, `profile` | Asked for by Bee Flow | No | Sign-in |
| `offline_access` | Asked for by Bee Flow | No | Stay connected |
| `User.Read` | Asked for by Bee Flow | No | Sign-in |
| `Mail.Read`, `Mail.Send` | Asked for by Bee Flow | No | Mail |
| `Mail.ReadWrite` | Asked for by Bee Flow (connect only) | No | Mail |
| `Mail.Read.Shared`, `Mail.Send.Shared`, `Mail.ReadWrite.Shared` | Asked for by Bee Flow (connect only) | No | Shared mailboxes |
| `Calendars.ReadWrite` | **Required** | No | Calendar: finding the Teams meetings you organise |
| `Files.ReadWrite` | Asked for by Bee Flow | No | Files |
| `Contacts.ReadWrite` | Asked for by Bee Flow | No | Contacts |
| `OnlineMeetings.ReadWrite` | Optional | No | Switching on Teams' **Record automatically** for a meeting |
| `OnlineMeetingRecording.Read.All` | **Required** | **Yes** | Meeting recordings |
| `OnlineMeetingTranscript.Read.All` | Optional | **Yes** | Meeting transcripts |

The admin-consent column follows Microsoft's
[permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference) for
delegated permissions.

### 3. Grant admin consent

`OnlineMeetingRecording.Read.All` and `OnlineMeetingTranscript.Read.All` need admin consent. Per
Microsoft, a **Cloud Application Administrator**, **Application Administrator**, **AI
Administrator** or **Privileged Role Administrator** may grant consent for delegated permissions
([Grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)).
Two ways:

- In the Entra admin center, under **API permissions** of the app registration (or **Enterprise
  apps**, **Permissions**), select **Grant admin consent**.
- In Bee Flow, an organisation admin opens **Settings, Organisation, Meeting Templates** and, in
  the Microsoft Teams Meeting Notes block, makes the **admin consent link**. They open it themselves when they hold one of the roles above,
  or copy it and send it to someone who does. The link uses Microsoft's
  [admin consent endpoint](https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent)
  with `/.default`, so Microsoft asks to approve every permission on the app registration. Its
  tenant is the configured Directory (tenant) ID, or, with `common` or `organizations`, the tenant
  of the organisation admin's own Microsoft sign-in.

:::tip[Only what Bee Flow uses]

Because the link approves everything on the app registration, remove permissions Bee Flow does not
use before you open it. The tables on this page are the complete list. Common leftovers:

- `Calls.AccessMedia.All`, `Calls.JoinGroupCall.All` and other `Calls.*` permissions: Bee Flow has
  no calling bot and never joins a meeting.
- `GroupMember.Read.All`, `User.Read.All`, `Application.Read.All`: only for Azure AD Group Sync.
- `OnlineMeetingArtifact.Read.All`: Bee Flow no longer asks for it.

With organisation-wide import, the test names every application permission in the app token that
Bee Flow does not use (`unused_roles`). Permissions already approved stay approved until you also
remove them under **Enterprise apps**, the app, **Permissions**.

:::

When the answer comes back to the same browser within 30 minutes, Bee Flow records whether consent
was granted, declined, or given in another tenant, and shows it in the organisation checks. A
forwarded link opened by someone else records nothing; the consent itself still counts at
Microsoft, and the other tests show it.

After consent, members who connected earlier reconnect Microsoft 365 once, so their connection
carries the new permissions.

### 4. Teams settings

A Microsoft Teams administrator checks these. Bee Flow cannot read them through Microsoft Graph,
so the tests show them only through a real meeting.

- **Recording**: the organiser's meeting policy allows cloud recording, in the Teams admin center
  or with `Set-CsTeamsMeetingPolicy -Identity Global -AllowCloudRecording $true`
  ([Teams recording policies](https://learn.microsoft.com/en-us/microsoftteams/meeting-recording)).
- **Transcription**: the meeting policy allows transcription, `Set-CsTeamsMeetingPolicy -Identity Global -AllowTranscription $true`
  ([Transcription and captions](https://learn.microsoft.com/en-us/microsoftteams/meeting-transcription-captions)).
- **Transcript API access**: in the Teams admin center, under **Meetings**, **Meeting settings**,
  switch on **Transcript API access** for Microsoft Graph. It is off by default; without it no app
  can read transcripts, whatever its permissions. Recordings are not behind this switch, which is
  why Bee Flow uses the recording first.
- **Include speaker attribution**: on the same page. Also off by default. Without it Microsoft
  refuses the speaker-attributed transcript that Bee Flow reads, so a meeting without a recording
  produces no note.

Both API switches can also be set with
`Set-CsTeamsMeetingConfiguration -Identity Global -EnableGraphTranscriptAccess $true -EnableAttributedTranscripts $true`
([Transcript API access](https://learn.microsoft.com/en-us/microsoftteams/meeting-transcript-api-access)).

### 5. Connect and test

1. Each organiser connects Microsoft 365 under **Settings, Connections**. Signing in to Bee Flow
   with Microsoft is enough for the pages you open yourself, but automatic import runs while you
   are away and uses only the stored connection.
2. Under **Settings, Preferences**, in the Microsoft Teams Meeting Notes section, **Test my
   connection** runs the member checks below. The section shows once Microsoft 365 is connected.
   Organisation admins have the same test in Settings, Organisation, Meeting Templates.
3. Automatic import is off by default. Members switch it on under Settings, Preferences;
   organisation admins can set it for everyone under Settings, Organisation, Meeting Templates.
   With it off, only the meetings a member imports by hand or marks for recording in the Upcoming
   tab are imported.

## Option B: organisation-wide

Option B imports the meetings of chosen members with the app registration's own permissions, so
those members do not each have to connect. It is a second way to get a token for the same import,
not a second pipeline: notes still belong to the organiser, and each member's choices per meeting
still count. It is off until an organisation admin switches it on.

### 1. Application permissions

Add these under **API permissions** as **Application permissions** (Microsoft Graph):

| Permission | Teams meeting notes | Admin consent | Used for |
|---|---|:---:|---|
| `OnlineMeetings.Read.All` | **Required** | **Yes** | Online meetings |
| `OnlineMeetingRecording.Read.All` | **Required** | **Yes** | Meeting recordings |
| `Calendars.Read` | **Required** | **Yes** | Calendar: finding the Teams meetings a member organises |
| `OnlineMeetingTranscript.Read.All` | Optional | **Yes** | Meeting transcripts |

Only a **Privileged Role Administrator** may grant admin consent for Microsoft Graph application
permissions; the other administrator roles above cannot
([Grant tenant-wide admin consent](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/grant-admin-consent)).
Without `OnlineMeetingTranscript.Read.All` in the app token, option B imports recordings only.

:::warning[Calendars.Read reads every mailbox]

As an application permission, `Calendars.Read` lets the app read the calendars of every mailbox in
the tenant. An Exchange administrator can limit it to specific mailboxes with an
[application access policy for mailboxes](https://learn.microsoft.com/en-us/graph/auth-limit-mailbox-access).
Bee Flow cannot see such a policy; a mailbox it excludes shows up as `calendar_forbidden` in the
test.

:::

### 2. Teams application access policy

Application permissions alone do not open online meetings: a Teams administrator must also allow
the app per user, or for everyone, with Teams PowerShell
([Allow applications to access online meetings on behalf of a user](https://learn.microsoft.com/en-us/graph/cloud-communication-online-meeting-application-access-policy)):

```powershell
New-CsApplicationAccessPolicy -Identity BeeFlowMeetingNotes -AppIds "<client id>"
# for one member, by their Entra object ID:
Grant-CsApplicationAccessPolicy -PolicyName BeeFlowMeetingNotes -Identity "<user object id>"
# or for the whole tenant:
Grant-CsApplicationAccessPolicy -PolicyName BeeFlowMeetingNotes -Global
```

A change can take up to 30 minutes to work. Without the policy Microsoft answers that no
application access policy allows the app, which the test reports as
`application_access_policy_missing`.

### 3. Link the organisation to its tenant

An app token is issued for one Microsoft tenant, so Bee Flow must know which tenant belongs to the
organisation. It takes this only from sources that a platform administrator set up and that
Microsoft verified; an organisation admin cannot type a tenant in:

- the **Directory sync binding** under Admin, Security, SSO, Microsoft (organisation ID and tenant
  ID), or
- on a server with exactly one organisation: the configured Directory (tenant) ID, when it is a
  tenant ID rather than `common` or `organizations`.

When the binding names a tenant that differs from the configured sign-in tenant, option B is not
available (`tenant_mismatch_sso`). On a server with several organisations and no binding for this
one, option B is not available.

### 4. Switch it on

In **Settings, Organisation, Meeting Templates**, under Microsoft Teams Meeting Notes, the
**Organisation-wide import** block shows whether option B can be switched on and, when it cannot,
why and who fixes it. There the organisation admin switches it on and chooses who it covers: all
members with Meeting Notes, or selected members (ticked in a list of the organisation's members).
Bee Flow asks for confirmation before switching it on, and switching it on or off is recorded in
the audit log. The block also counts how many members are covered and why the others are not.
**Test organisation-wide import** runs the option B checks with a covered member you pick under
**Test with member**. While nobody is covered there is nobody to pick: the checks up to the app
token still run, the coverage check says that no member is covered yet, and the checks that need
a member are skipped.

### Who is covered

A member is covered only when all of these hold, checked when meetings are found and again just
before each import:

1. Organisation-wide import is allowed on this server (`TEAMS_APP_IMPORT` is not `0`) and switched
   on for the organisation.
2. The organisation is still linked to the same tenant as when it was switched on.
3. The member's account is active and still in this organisation.
4. The member signed in to Bee Flow with Microsoft from that tenant (or a platform administrator
   linked their Microsoft identity), so Bee Flow knows their Entra object ID. Bee Flow never looks a
   member up by e-mail address.
5. The member is selected, or the coverage is all members.
6. The member has Meeting Notes access.
7. An app registration exists for the tenant.

### What members see

A covered member sees in Settings, Preferences that their organisation imports the Teams meetings
they organise, and that they do not need to connect Microsoft 365 for that. The Teams meeting notes
section then shows also without an own connection, without the reconnect prompt, and with their
personal settings (automatic import, language). **Test my connection** tests the member's own
connection, so it shows only once they have one. The member overview marks covered members. Its
automatic import column says **Runs** only when automatic import is switched on for the whole
organisation, **Off** when the organisation switched it off, and otherwise that it depends on the
member's own setting (which is off until the member switches it on).

Organisation-wide import supplies the access, not the choice of meetings: automatic import and the
per-meeting marks keep their meaning. The Upcoming tab and manual import (**New transcription,
Microsoft Teams**) still use the member's own connection, so for members who do not connect, switch
automatic import on for the organisation. Left to members (the default), a covered member who never
connected gets nothing imported until they switch automatic import on in their own settings; the
organisation-wide import panel warns about this.

## Not supported

| Way | What it would give | Why Bee Flow does not use it | When it would matter |
|---|---|---|---|
| A Teams app per meeting (resource-specific consent) | Access to the meetings where the app is added, without tenant-wide consent | It needs a Teams app manifest rolled out to your tenant and added to each meeting, and it covers scheduled private meetings only | When no administrator will grant tenant-wide consent |
| Change notifications | A signal when a recording or transcript is ready, instead of polling | It needs a publicly reachable webhook and a subscription renewed at least every 3 days | When notes must appear within minutes of the meeting |
| Recording files from OneDrive or SharePoint | The recording as a file, without Teams policies | A file has no reliable link to the meeting or its calendar entry, so per-meeting choices and duplicate checks cannot work | When the Graph meeting APIs are blocked but files are not |
| Copilot meeting notes | Microsoft's own notes and action items | Each user needs a Microsoft 365 Copilot licence, and Bee Flow makes its own notes with your own transcription and models | When every organiser already has a Copilot licence and Microsoft's notes are wanted as they are |

Not available in this version either: importing meetings of someone who did not organise them,
manual import with the app token, and testing extra sign-in connections (other tenants' app
registrations) from the platform test.

## The tests

| Test | Where | Who |
|---|---|---|
| App registration | Admin, Security, SSO, Microsoft, test button | Platform administrator |
| Member connection | Settings, Preferences, **Test my connection** (also in Settings, Organisation, Meeting Templates) | Every member with Meeting Notes |
| Organisation checks and member overview | Settings, Organisation, Meeting Templates, Microsoft Teams Meeting Notes | Organisation admin |
| Organisation-wide import | Settings, Organisation, Meeting Templates, Organisation-wide import, **Test organisation-wide import** | Organisation admin |

Each check shows a status (passed, failed, needs attention, skipped, could not be tested), a
sentence, what to do and who can do it. A check whose prerequisite did not pass is **skipped**;
fix the failed checks from the top down. A check that has nothing to test with (for example no
recent meeting) says **could not be tested**, never failed.

The member test uses a real meeting: the newest Teams meeting you organised that ended in the
last 7 days, or else the next one you organise in the next 48 hours (looked up only). Schedule a
short Teams meeting from your calendar, record it and end it, if you have none.

What the tests never do:

- They only read. They never change a meeting, never switch on recording, never import anything.
- A transcript is read only to see that it can be read; its text is discarded at once.
- A report never contains a token, the client secret, Microsoft's raw answer, a meeting title,
  attendees or another person's e-mail address. The tenant and client ID appear only in the
  platform and organisation reports.

The member overview is built only from what Bee Flow has stored (connection status and granted
permissions, failed import codes, the last automatic-import skip reason). It asks Microsoft
nothing and shows no meetings.

## Troubleshooting

Every code a test can report. The same code can come from more than one check; "who fixes" is the
usual one.

### App registration and Microsoft sign-in

| Code | Meaning | Who fixes | What to do |
|---|---|---|---|
| `client_id_missing` | No Application (client) ID is filled in | Platform administrator | Fill it in from the app registration's Overview page |
| `client_id_invalid` | The client ID is not a valid ID | Platform administrator | Copy the Application (client) ID again; it looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` |
| `secret_missing` | No client secret is stored (or Microsoft got none, AADSTS7000218) | Platform administrator | Create a client secret and paste its Value |
| `tenant_invalid` | The tenant is not a tenant ID, `common`, `organizations` or `consumers` | Platform administrator | Fill in the Directory (tenant) ID, or `common` |
| `tenant_consumers` | The tenant is `consumers` | Platform administrator | Use your tenant ID, `organizations` or `common`; Teams needs work or school accounts |
| `tenant_needed` | The tenant is `common` or `organizations` and Bee Flow does not know yours | Platform administrator | Sign in to Bee Flow with Microsoft once, or fill in the tenant ID |
| `tenant_unknown` | No tenant known for the admin consent link | Platform administrator | Same as `tenant_needed` |
| `secret_invalid` | Microsoft rejected the secret (AADSTS7000215) | Platform administrator | Create a new client secret and paste its Value, not its ID |
| `secret_expired` | The secret has expired (AADSTS7000222) | Platform administrator | Create a new client secret |
| `app_not_in_tenant` | The app is not known in this tenant (AADSTS700016) | Entra administrator | Check client ID and tenant; for an app from another tenant, open the admin consent link once |
| `resource_principal_missing` | Microsoft Graph is not available to the app in this tenant (AADSTS500011) | Entra administrator | As `app_not_in_tenant` |
| `tenant_not_found` | Microsoft does not know the tenant (AADSTS90002) | Platform administrator | Fill in the right Directory (tenant) ID |
| `app_disabled` | The app is disabled (AADSTS70001, AADSTS7000112) | Entra administrator | Enable sign-in for the enterprise application |
| `consent_missing` | Nobody consented to the app yet (AADSTS65001) | Entra administrator | [Grant admin consent](#3-grant-admin-consent) |
| `admin_consent_required` | An administrator must approve the app first (AADSTS90094, AADSTS90095) | Entra administrator | [Grant admin consent](#3-grant-admin-consent) |
| `consent_declined` | Consent was declined (AADSTS65004) | Entra administrator | Open the admin consent link again and accept |
| `permission_not_on_app` | A permission Bee Flow asks for is not on the registration (AADSTS650056, 650057, 70011, 65005) | Entra administrator | Add it under API permissions, then grant admin consent |
| `blocked_by_conditional_access` | A Conditional Access policy blocked the request (AADSTS53003, 530032, 530035) | Entra administrator | Check that policy |
| `mfa_required` | Multi-factor authentication is required (AADSTS50076, 50079) | The member | Sign in again and complete MFA |
| `user_not_assigned` | The account is not assigned to the app (AADSTS50105) | Entra administrator | Assign the user or a group, or turn off Assignment required |
| `redirect_uri_mismatch` | The redirect address is not registered (AADSTS50011) | Platform administrator | Add both Web redirect URIs exactly as shown |
| `account_not_in_tenant` | The account is not in this tenant (AADSTS50020, 50034) | The member | Sign in with an account from the organisation's tenant |
| `single_tenant_app_common` | A single-tenant app used with `common` (AADSTS50194) | Platform administrator | Fill in the app's own tenant ID |
| `app_not_for_tenant` | The app allows only its own tenant (AADSTS650059) | Platform administrator | Make it multi-tenant, or fill in its own tenant ID |
| `entra_error` | Another Microsoft error, with its AADSTS code | Platform administrator | Look the code up in Microsoft's [error code reference](https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes) |
| `entra_error_no_code` | A Microsoft error without a code | Platform administrator | Check the server log |
| `entra_unreachable` | Bee Flow could not reach Microsoft's sign-in service | Platform administrator | Let the server reach `login.microsoftonline.com` over HTTPS |
| `manual_check` | Redirect URIs cannot be read from Microsoft | Platform administrator | Check that both listed addresses are registered |
| `app_not_configured` | No app registration in Bee Flow (or none for this tenant) | Platform administrator | Fill in Admin, Security, SSO, Microsoft |

### Member connection and permissions

| Code | Meaning | Who fixes | What to do |
|---|---|---|---|
| `capability_missing` | The account has no Meeting Notes access, so imports do not run | Organisation admin | Give the account Meeting Notes access, if its meetings should be imported |
| `not_connected` | Microsoft 365 is not connected | The member | Connect under Settings, Connections |
| `needs_reauth` | The Microsoft 365 connection has expired | The member | Reconnect under Settings, Connections |
| `scope_missing` | Microsoft did not grant a permission (named in the result) | The member for `Calendars.ReadWrite` and `OnlineMeetings.ReadWrite`; an Entra administrator for the recording and transcript permissions | Reconnect and accept; when Microsoft asks for an administrator, grant admin consent |
| `needs_teams_scopes` | Microsoft refused because the Teams meeting permissions are not granted | Entra administrator | Grant admin consent, then the member reconnects |
| `no_stored_connection` | Only connected through sign-in; automatic import needs a stored connection | The member | Connect Microsoft 365 under Settings, Connections |
| `stored_connection_missing_scopes` | The stored connection lacks permissions (named in the result) | The member | Reconnect and accept |
| `stored_connection_expired` | The stored connection has expired | The member | Reconnect |
| `auto_import_off` | Automatic import is off | The member, or the organisation admin when it is off for everyone | Switch it on in Settings, Preferences (or Settings, Organisation, Meeting Templates) |
| `auto_import_skipped` | The last automatic import run skipped the account; the result names the reason (see below) | Depends on the reason | See the skip reasons below |

### Calendar and meetings

| Code | Meaning | Who fixes | What to do |
|---|---|---|---|
| `no_teams_meetings` | No Teams meeting you organised in the last 7 days or the next 48 hours | The member | Schedule a short Teams meeting from your calendar, record it, end it, test again |
| `no_meeting_to_probe` | No meeting to test with, so the meeting checks could not run | The member | As `no_teams_meetings` |
| `calendar_forbidden` | Microsoft refused access to the calendar | Entra administrator | Check that `Calendars.ReadWrite` (option B: the application permission `Calendars.Read`) is on the registration and consented, and that no Exchange policy excludes the mailbox |
| `recording_not_allowed` | Recording is switched off for this meeting | Teams administrator | Allow cloud recording in the organiser's meeting policy (`AllowCloudRecording`) |
| `meeting_not_available` | Microsoft has no online meeting for this calendar entry | The member | Schedule meetings as Teams meetings from Outlook or Teams; expired meetings cannot be read |
| `graph_forbidden` | Microsoft refused access: a permission, licence or Teams policy blocks it | Teams administrator | Check the account's Teams licence and the recording and transcription policies |
| `transcript_api_disabled` | Transcript API access is off in the tenant | Teams administrator | Switch on [Transcript API access](#4-teams-settings); recordings keep working |
| `no_transcript_to_probe` | The meeting has no transcript to test with | Nobody | Nothing to do; transcribe a test meeting to test this part |
| `speaker_attribution_off` | Speaker names in transcripts are not allowed | Teams administrator | Switch on [Include speaker attribution](#4-teams-settings) |
| `graph_throttled` | Microsoft is limiting requests | The member | Try again in a few minutes |
| `graph_unavailable` | Microsoft Graph answered with an error (HTTP status in the result) | The member | Try again in a few minutes |
| `graph_error` | Microsoft Graph could not be reached | The member | Try again in a few minutes |
| `probe_timeout` | Microsoft did not answer in time (`TEAMS_DIAGNOSTICS_PROBE_TIMEOUT_MS`) | The member | Try again later |
| `prerequisite_failed` | Not tested until an earlier check passes; the row names that check. Skipped rows are folded under one **Skipped** line | Whoever fixes that check | Fix the named check first, then test again |

### Admin consent

| Code | Meaning | Who fixes | What to do |
|---|---|---|---|
| `consent_granted` | An administrator granted consent through the link (date in the result) | Nobody | Nothing |
| `consent_denied` | Consent was not completed (Microsoft's error in the result) | Entra administrator | Open the link again as an administrator who may grant these permissions |
| `consent_tenant_mismatch` | Consent was given in a different tenant than Bee Flow asked | Entra administrator | Open the link while signed in to the organisation's tenant |
| `consent_not_recorded` | No answer came back to this browser | Entra administrator | Open the link, or ignore this when an administrator approved elsewhere: the other checks show it |

### Organisation-wide import

| Code | Meaning | Who fixes | What to do |
|---|---|---|---|
| `app_import_disabled_instance` | Switched off on this server (`TEAMS_APP_IMPORT=0`) | Platform administrator | Remove the switch, if wanted |
| `tenant_not_bound` | The organisation is not linked to a Microsoft tenant | Platform administrator | Set the [directory sync binding](#3-link-the-organisation-to-its-tenant) |
| `tenant_mismatch_sso` | The linked tenant differs from the sign-in tenant | Platform administrator | Make the binding and the configured tenant agree |
| `role_missing` | The app token lacks an application permission (named in the result) | Entra administrator | Add it as an Application permission and have a Privileged Role Administrator grant consent |
| `roles_unreadable` | Bee Flow could not read the permissions from the app token | Nobody | The checks after it show whether they work |
| `unused_roles` | The app token carries application permissions Bee Flow never uses (named in the result) | Entra administrator | Remove them under API permissions, and the consent already given under Enterprise apps, the app, Permissions |
| `application_access_policy_missing` | No Teams application access policy allows the app for this member | Teams administrator | Create and grant the [policy](#2-teams-application-access-policy); allow up to 30 minutes |
| `not_enabled` | Organisation-wide import is off | Organisation admin | Switch it on |
| `nobody_covered` | No member is covered yet | Organisation admin | Members are covered once they signed in with Microsoft from your tenant and have Meeting Notes |
| `no_probe_user` | No covered member picked to test with | Organisation admin | Pick a covered member, or include yourself |
| `probe_user_not_covered` | The picked member is not covered (reason in the result) | Organisation admin | Pick a covered member |

### Automatic import skip reasons

When the automatic import run skips a member, Bee Flow stores why; the member test and the member
overview show it.

| Reason | Meaning | Who fixes | What to do |
|---|---|---|---|
| `not_licensed` | No Meeting Notes access | Organisation admin | Give the account access |
| `no_credential` | No stored Microsoft 365 connection | The member | Connect under Settings, Connections |
| `credential_needs_reauth` | The stored connection has expired | The member | Reconnect |
| `credential_revoked` | The stored connection was revoked | The member | Connect again |
| `missing_scopes` | The stored connection lacks required permissions (named) | The member | Reconnect and accept |
| `session_unavailable` | The stored connection could not be used | The member | Reconnect |
| `app_token_failed` | Option B: Microsoft did not issue the organisation app token | Organisation admin | Run Test organisation-wide import and follow the failing check |

### Import errors

What a failed import itself reports, in the Upcoming tab, the import list and the member overview.

| Code | Meaning | What to do |
|---|---|---|
| `no_recording` | No recording or transcript 48 hours after the meeting ended | Record the meeting, or switch on automatic recording |
| `recording_too_large` | The recording is over a limit: the video download is capped at `TEAMS_MAX_RECORDING_BYTES` (default 6 GiB), the extracted audio at 500 MB | Split the meeting, or upload the audio by hand |
| `meeting_not_available` | Microsoft has no online meeting for the calendar entry | See above |
| `graph_forbidden` | Microsoft refused access to the meeting | Run the member test |
| `application_access_policy_missing` | Option B: no Teams application access policy for this member | See above |
| `calendar_forbidden` | Microsoft refused access to the calendar | See above |
| `transcript_access_disabled` | Transcript API access is off; the meeting had only a transcript | Switch on Transcript API access, or record meetings |
| `speaker_attribution_disabled` | Speaker attribution is off; the meeting had only a transcript | Switch on Include speaker attribution, or record meetings |
| `needs_teams_scopes` | The connection lacks the Teams permissions | Grant admin consent and reconnect |
| `not_connected`, `needs_reauth` | No usable Microsoft 365 connection, or it has expired | Reconnect Microsoft 365 under Settings, Connections |
| `graph_throttled`, `graph_unavailable` | Microsoft was limiting requests or answered with an error; automatic import tries again | Wait; a manual import can be started again |
| `download_failed` | The recording could not be downloaded from Microsoft | Try again |
| `empty_transcription` | The recording or the Teams transcript contained no speech | Nothing to fix in Teams; check the recording |
| `already_imported` | A colleague already imported this meeting, and you cannot read that note | Ask them to share the meeting note |
| `provider_not_allowed` | The transcription engine is not enabled for this workspace | Pick an allowed engine, or ask an administrator to allow this one |
| `too_many_imports` | Too many manual imports are running at once | Wait for one to finish |
| `not_organizer` | The account did not organise the meeting | Ask the organiser to import it |
| `failed` | Another failure | Try again; if it keeps failing, the platform administrator checks the server log |

### Errors of the setup pages

The setup pages themselves can refuse a request. The page shows a sentence; the code is in the
answer.

| Code | Meaning |
|---|---|
| `diagnostics_rate_limited` | A test was started again within `TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS`; wait and test again |
| `not_org_admin` | Only organisation admins can use the organisation part |
| `no_organisation` | The account is not in an organisation |
| `org_scope_unavailable` | Bee Flow could not determine the organisation just now; try again |
| `not_a_member` | A selected member, or the member picked for the test, is not an active member of this organisation |
| `too_many_selected` | More members selected than `TEAMS_APP_IMPORT_MAX_SELECTED_USERS` allows |
| `app_import_unavailable` | Organisation-wide import cannot be switched on yet; the organisation-wide import block says why |

## Environment variables

All optional. A limit is a whole number with a generous default; `0` means unlimited (or no
timeout). See [Environment variables](../self-hosting/env.md#teams-meeting-notes).

| Variable | Default | Purpose |
|---|---|---|
| `TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS` | `10` | Seconds between two runs of the same test by one person (app registration test, member test, organisation-wide import test; each has its own interval) |
| `TEAMS_DIAGNOSTICS_PROBE_TIMEOUT_MS` | `15000` | How long one Microsoft request of a test may take |
| `TEAMS_DIAGNOSTICS_MAX_MEMBERS` | `2000` | Members shown in the member overview |
| `TEAMS_APP_IMPORT_MAX_SELECTED_USERS` | `5000` | Members an organisation admin may select for option B |
| `TEAMS_APP_IMPORT` | `1` | `0` switches organisation-wide import off for the whole server |

## Privacy

- Recording meetings is processing of personal data: set a lawful basis, tell participants, and
  consider a DPIA before you roll it out (see the
  [Microsoft 365 page](./microsoft.md#before-you-roll-it-out)).
- The tests only read, and they never change a meeting. What they read of a meeting is used to
  decide pass or fail and then dropped; it does not appear in a report or a log.
- The member overview uses stored state only and contains no e-mail addresses, meeting titles or
  attendees.
- With option B, the app token stays in the server's memory. It is never stored, logged or sent to
  a browser, and it is used only for members who pass every coverage rule for that token's tenant.

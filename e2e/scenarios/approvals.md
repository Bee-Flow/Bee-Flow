---
id: approvals
title: An approval pauses a routine; deciding it in the Approvals section resumes or stops the run
mode: agentic
tags: [approvals, automations]
requires: []
timeout: 180000
auth: admin
cleanup: "Delete the routine named with the runId (Studio → Routines → ⋯ → Delete). Any approval rows it created become 'cancelled' automatically once the routine's runs are gone."
---

## Steps

1. Open `/app/studio/automations` and create a routine named `e2e-${runId}-approval`
   with a **manual** trigger, an **Approval** step (question:
   `Approve e2e ${runId}?`, deadline left at the 7-day default, approver left
   at "Me (the owner)"), and any harmless step after it (e.g. a notification
   step) so approving demonstrably continues the run.
2. Run the routine manually (Run/Test button). The run should pause: its
   status shows as awaiting approval.
3. Open `/app/studio/approvals`. The **Waiting** tab shows a row
   (`data-testid="approval-row"`) whose question contains `${runId}`.
   The search box (`data-testid="approvals-search"`) narrows the list when
   given `${runId}` and shows the same row.
4. Open the row. The detail shows the question, "Owner decides", the deadline,
   and the decision controls.
5. Click **Reject** WITHOUT a reason — the Reject button is disabled and the
   hint "Add a reason to reject." is visible (nothing is submitted).
6. Type a reason (`e2e ${runId} reject test`) and click **Reject**. A toast
   confirms; the status chip flips to **Declined**; the History strip gains a
   "Rejected" line quoting the reason.
7. Run the routine again (a second run pauses). This time open the approval
   and click **Approve**. A toast confirms the run is continuing; the chip
   flips to **Approved**.
8. Back on the list, the **Waiting** tab no longer shows either row; the
   **Approved** and **Declined** tabs show one row each (facet counts on the
   tabs agree).

## Expected

- A paused run creates exactly one row in the Approvals section per pause.
- Reject is impossible without a reason (client-side disabled AND, if forced
  via the API, the server answers 400).
- Rejecting closes the run as failed with class ApprovalRejected; approving
  resumes it (the follow-up step's effect exists / the run shows success).
- The decided rows LEAVE the Waiting tab immediately (no refresh needed).
- Deep link: `/app/studio/approvals/<id>` opens the detail directly, and the
  browser Back button returns to the list.

## Notes for generation

- Prefer `data-testid="approval-row"` and `data-testid="approvals-search"`;
  the decision buttons are the accessible buttons named exactly "Approve" and
  "Reject" INSIDE the detail panel (the list rows also contain the word
  "Approve" in their question text — match by role+exact name).
- Approving triggers a server-side resume that can take a few seconds; wait on
  the toast, then on the chip text, never on a timeout.
- The bell (notifications) also carries a link to the approval — optional
  extra assertion: the newest notification's row click navigates to
  `/app/studio/approvals/<id>`.

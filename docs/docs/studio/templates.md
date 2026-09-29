---
title: Templates
---

# Templates

A **template** is a Word document (`.docx`) with `{{parameter}}` placeholders in it. Upload the document once, and the AI fills the placeholders for you — from a meeting note, from your own instructions, or from values you type in.

Templates are **Word documents, not agent recipes**. There is no gallery of pre-built agents here, no install, no fork and no marketplace. To share a working agent configuration, use a [Solution](solutions.md).

URL: `/app/templates`. This is not a Studio section — it has its own top-level page, reached from the workspace rather than from the Studio rail.

![Word templates library](../img/screenshots/studio/templates-marketplace/)

## Uploading

Only `.docx` is accepted; anything else is refused, in the browser and again on the server.

Write placeholders in the document in either form:

```
{{Client name}}
{{Delivery date: the agreed date, written out in full}}
```

On upload the server reads the document's text and pulls out every distinct placeholder, in order of first appearance. The part before the first colon is the parameter's **name**; anything after it is its **description**, which is what the AI is told the field means. A placeholder that appears twice is listed once.

Upload also kicks off a one-off pass that drafts the template's description and its filling instructions, and builds a small knowledge base from the document. That takes up to about a minute; the panel says so while it runs.

## Your templates are yours

Every template belongs to the account that uploaded it. Listing, opening, renaming, downloading, filling and deleting are all scoped to your own user id — there is no org-wide template library, no sharing, and no visibility setting.

## Filling a template

Open a template and the right-hand panel shows:

| Block | What it is for |
|-------|----------------|
| Parameters | Every placeholder found in the document. "No parameters detected in this template" when the document has none |
| Meeting Notes Context | Search and attach a meeting note; the AI draws the values out of it |
| Description | What this template is for |
| Custom Instructions | Standing guidance for every fill — e.g. *"Always use formal Dutch"*, *"Company address is …"*, *"Use metric units"*. Saved on the template |

**Fill this template with AI** runs a chat turn against the template, using the description, your custom instructions and any attached meeting note. You can also fill the values in by hand.

Filling produces a real `.docx` — the placeholders are substituted in the original document, so its styling, headers and numbering survive. You can download the result, or store it.

## Managing

Each row in the list has **Download** (the blank template), **Rename** and **Delete**. Search filters by name.

## What this page does not do

The following do not exist anywhere in the product, on this page or elsewhere:

- Categories (Sales / Marketing / Engineering / …)
- An **Install** button, or cloning a template into an agent
- **Save as template** in the agent builder
- **Fork**
- Template versioning or an "update available" badge
- Team / org / public visibility, or a public template marketplace

If you want a starting point for a new agent, describe what you want in the agent builder and let it assemble one. If you want to move a whole working setup between installs, package it as a [Solution](solutions.md).

---
title: Using values from earlier steps
sidebar_label: Values from earlier steps
---

# Using values from earlier steps

Most steps in an automation need something an earlier step produced: the e-mail
address of the customer who placed an order, the products in that order, the
summary an AI step wrote. This page explains how you put such a value into a
field, what happens when the value is a list, and how to run a step once for
every item of a list.

You never have to type a path or a formula for this. Everything below works by
picking.

## Picking a value

On the left of a step's settings you see **Comes in**: one card for each earlier
step, and one for the data the automation was started with (**Incoming data**).
Each row is one value, with its name, a small icon for what kind of value it is,
and a grey example taken from a test run or from the last real run.

- A group of values (a customer, an address) opens like a folder:
  *Customer › Address › Postcode*.
- A list shows how many items it holds, for example *Order lines · 12*. It opens
  to show what each item contains, also before the automation has ever run.
- A value that a test example has but the last real run did not have is shown
  dimmed, with *Not in the last run*.
- Technical values (counters, internal ids) are folded away under
  *Technical details*.

To use a value:

1. Click the field in the step you want to fill.
2. Click the value under **Comes in**.

If no field has focus, Bee Flow asks **Where should this go?** and lists the
empty fields of the step, the required ones first.

The field now shows the value as a chip with its name, for example
**E-mail of customer**, and an example of what it holds. Picking another value
into the same field replaces it; **Undo** brings the old one back.

You can also tap **Insert data** under a field (on the phone, this is the only
way) and choose the value from the list.

### When a value is no longer there

If the step a value came from was removed, or the field was renamed, the chip
turns amber: *No longer available: E-mail of customer*. Click **Pick again** to
choose its replacement.

## Text with values in it

In a text field (a prompt, the body of a message, a subject line) you can type
and put values in between your words:

> Dear **Name of customer**, your order contains: **Product of all order lines**

The value goes in where your cursor is, and never replaces what you typed. A
value is one block: one Backspace removes it whole.

## Lists

When the value you pick holds more than one item, the field says in one short
sentence what it will receive, for example:

- *Comes as text: all 12, one per line.*
- *Comes as a list of 12.*
- *Only the first.*

Click **Change** (on the phone: tap the chip) to choose another way. Every
choice shows a live example of what the field would get:

| Choice | What the field gets |
|--------|---------------------|
| All, one per line | Every item on its own line. |
| All, with commas | Every item on one line, separated by commas. |
| All, as a bulleted list | Every item on its own line, with a bullet. |
| Only the first / Only the last | One item. |
| The number | How many items there are. |

A table (a list of records, such as order lines) is written one line per row,
for example *Chair · 2 · €40*. You never get raw data or *[object Object]*.

What Bee Flow chooses for you depends on the field:

- **A text field** gets all items: one per line in a field with several lines,
  separated by commas in a one-line field.
- **A field that takes a list** (for example *Recipients*) gets the list. When
  you drop a whole table into it, Bee Flow picks the column that matches the
  field's name and asks **Which column?** so you can check. If no column
  matches, the question is shown in amber.
- **A field for one number, date or yes/no** gets only the first item. The
  sentence is shown in amber, because a list going into a field for one value
  is usually not what you meant. Choose another value, or run the step for
  each item (see below).

To use exactly one row of a list, pick that row under **Comes in**
(*The first order line*), or choose **Advanced › Exactly this row** in the
choices.

## Running a step for each item

Sometimes a step should run once for every item of a list: send one e-mail per
order line, create one card per issue. You set this in the step itself, under
**Advanced**:

1. Open the step's **Advanced** section.
2. Turn on **Run this step separately for each…** and choose the list, for
   example *Order lines from Get orders*.
3. Optionally set **At most**: how many items one run handles (1 to 1000). The
   rest is skipped, and the run tells you so.

While this is on, the top of the step says so in one sentence, for example
*Runs separately for each item in Order lines (12×)*, with a link back to the
setting. Under **Comes in** a new group shows the current item. Values you pick
from it read the item the step is working on: **E-mail (of this order line)**.

Turning the setting off makes those values read the whole list again. A step can
repeat over one list at a time; choosing a second list is refused with
*This step already runs separately for each item in …*.

Bee Flow never turns this on by itself. Picking a list into a field always gives
the list (or its text) to one run of the step.

## Formulas

Some values are calculations rather than a value as it is: a comparison, a sum,
a date written in a particular way. These show as a grey **Formula** chip with
the formula in words beside it. Click it (or choose **Advanced › Write a formula
instead**) to edit the formula itself.

Automations made before this way of picking existed keep working exactly as they
did. Their fields show as chips wherever Bee Flow can prove the chip gives the
same result, and as a **Formula** otherwise. A field is only rewritten when you
change it yourself.

## Updating older automations

To bring an older automation up to date in one go, open its settings and go to
**General › Actions › Update mappings**, then click **Check…**. Bee Flow compares
every field with the last run (or with the test example) and shows what it would
change, for example *8 field(s) can be updated, 2 stay a Formula*. Any field
whose result would change is left exactly as it is. Nothing is saved until you
apply it, and the change is saved as a new version you can roll back.

## On the phone

The Android app shows the same chips, sentences and choices. Tap a chip to
change how a value is used; the choices open in a sheet at the bottom of the
screen. In a text field, the values that hold a list are listed under the field
so you can change each one. A formula shows as a **Formula** chip; tap it to
edit the formula.

## See also

- [Automations](../features/automations.md): triggers, step types and runs.

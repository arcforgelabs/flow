# Custom fields

Custom fields are the lab's own fields for its jobs, like custom fields in
ClickUp or Jira. An owner or admin makes them in Settings, Custom fields.
Everyone can set a job's value. A value lives only in Flow: a change never
writes to the work system (Seazona) or the accounting system (Xero).

Code: `server/core/custom-fields.js`. Screen: Settings, Custom fields
(`server/ui/custom-fields.js`). API: `server/api/custom-fields.js`. On the
Jobs page, a job's panel shows its fields to change, and the board can be
grouped by a dropdown, person or checkbox field and moved by drag
(`docs/JOB_BOARD_MOVES.md`).

## The parts

| Part | What it is |
| --- | --- |
| Field | One row in `job_fields`: a name, a type, and for a dropdown its options in lane order. |
| Value | One row in `job_field_values`: one job's value for one field. A job is the work system's job, `(source_system, source_job_ref)`, the same key the Jobs board uses. |
| Event | One row in `job_field_events`: who changed a value, from what, to what, and when. |
| System field | A work system's own field, read only. Today: each work system's job statuses (its stage), from the port's `listWork`. |

## Types

| Type | Value | Board lanes |
| --- | --- | --- |
| Dropdown | One option id | Yes, one lane per option |
| Person | One active person's id | Yes, one lane per person |
| Checkbox | `true` or `false` | Yes |
| Date | `YYYY-MM-DD` | No |
| Number | A number | No |
| Text | Up to 500 characters | No |

## Rules

- A field's type is fixed once it exists.
- Names are unique among live fields, with no regard to case. An
  organisation has 50 live fields at most, and a dropdown 50 options.
- An option a person removes is kept as archived, so a job that still has
  it reads its name. A new value cannot use it.
- Archive keeps a field's values. Bring back restores them.
- A value of `null` clears the value.

## Moves and conflicts

A drag between lanes sets one value with `expectedUpdatedAt`: the
`updatedAt` of the value the person last saw, or `null` when they saw none.
When someone changed it since, Flow changes nothing and answers 409 with
the current value in `details.current`. The board then shows the current
value. This copies OpenClaw's workboard: the server's copy wins.

## API

| Route | Who | What |
| --- | --- | --- |
| `GET /api/custom-fields[?archived=1]` | Signed in | Fields, system fields, the people a person field can name (active people, by name), types, groupable types, option colours |
| `POST /api/custom-fields` | Owner, admin | Make a field: `{ name, type[, options] }` |
| `PUT /api/custom-fields/order` | Owner, admin | `{ ids }`: every live field, in the new order |
| `PUT /api/custom-fields/:id` | Owner, admin | `{ name?, options? }` |
| `POST /api/custom-fields/:id/archive` | Owner, admin | `{ archived }` |
| `GET /api/custom-fields/values` | Signed in | Every value of the live fields |
| `PUT /api/custom-fields/values` | Signed in | `{ sourceSystem, sourceJobRef, fieldId, value[, expectedUpdatedAt] }` |
| `GET /api/custom-fields/history?sourceSystem=&sourceJobRef=` | Signed in | One job's changes, newest first |

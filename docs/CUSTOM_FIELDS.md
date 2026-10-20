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

## The screen

Settings, Custom fields is laid out like ClickUp's Custom Field Manager:

- **Toolbar:** search (names and option names), Field type (show some
  types only), Filter (Show archived fields), and Create field.
- **Table:** one group per type, in name order. A group's header shows the
  type's icon, name and count, and folds the group open and closed. An
  owner or admin clicks the group's pill to give the group a colour. Folded
  groups stay folded in that browser; a search opens every group with a
  match. Each group ends with "Create *type* field".
- **Row:** the field's name, its type as an icon in its colour, who made
  it, the day it was made, and where it applies (Jobs). Rows do not show
  options. Under the pointer, Edit opens the sidecar. The type icon picks
  the field's colour. The ⋯ menu has Edit, Rename (in place), Colour,
  Duplicate, Convert (not in Flow yet), Copy custom field ID, Archive and
  Delete. An archived field's menu has Bring back and Delete.
- **Sidecar:** like ClickUp's, a panel that slides in from the right of
  the manager, below the toolbar: the type in its head (a new field picks
  it there), the name, the colour, a dropdown's options (each with its
  colour dot; Add option), where the field belongs, and Delete, Cancel and
  Save at its foot. The table stays usable behind it: another row's Edit,
  or Create, switches the sidecar at once. Save, Cancel, × and Esc close it.
- **Colours:** every colour picker (a group, a field, an option) shows the
  real pill in each colour, so a person sees the result before they pick.
  A field with no colour of its own takes its group's colour.
- **Delete:** asks first and says how many jobs have a value. Delete takes
  the field, its values and its history for good; Archive keeps them.
- **From *system*:** the work system's own fields (Seazona's stage), read
  only, in their own group. View opens the sidecar, read only, with the
  stages as the Jobs board's stage pills, in board order. Its Date
  created is the day the system was connected: the first time its
  settings were saved in Flow, or, for a system set up in the host's own
  settings, the first time Flow saw its work.
- On a phone the table keeps the name, the type icon and the menu.

Icons come from Lucide (`lucide-static`, ISC), served one file each at
`/assets/icons/<name>.svg`, so any page can use any Lucide icon.

## The parts

| Part | What it is |
| --- | --- |
| Field | One row in `job_fields`: a name, a type, a colour (or none: its group's), and for a dropdown its options in lane order. |
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

Every lab has an **Assignee**: a person custom field Flow makes once, the
first time the lab's custom fields are read and the lab has no person
field (live or archived). The lab can rename it or archive it; Flow does
not make it again, also when the lab deletes it
(`job_field_settings.assignee_made_at`). The Jobs list shows the first person custom field as
the Assignee column, and Filter has "Assignee: me".

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
| `GET /api/custom-fields[?archived=1]` | Signed in | Fields (each with `color` and `valueCount`), system fields (with `createdAt`, when the system was connected), the people a person field can name (active people, by name), types, groupable types, option colours, `groupColors` |
| `POST /api/custom-fields` | Owner, admin | Make a field: `{ name, type[, options, color] }` |
| `PUT /api/custom-fields/order` | Owner, admin | `{ ids }`: every live field, in the new order |
| `PUT /api/custom-fields/groups/:type` | Owner, admin | `{ color }`: a type group's colour; `null` puts back its own |
| `PUT /api/custom-fields/:id` | Owner, admin | `{ name?, options?, color? }`; `color: null` takes the group's colour |
| `POST /api/custom-fields/:id/archive` | Owner, admin | `{ archived }` |
| `DELETE /api/custom-fields/:id` | Owner, admin | Delete the field, its values and its history |
| `GET /api/custom-fields/values` | Signed in | Every value of the live fields |
| `PUT /api/custom-fields/values` | Signed in | `{ sourceSystem, sourceJobRef, fieldId, value[, expectedUpdatedAt] }` |
| `GET /api/custom-fields/history?sourceSystem=&sourceJobRef=` | Signed in | One job's changes, newest first |

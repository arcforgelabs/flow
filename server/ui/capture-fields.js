// The job fields the photo reader asks for (server/core/reader.js) and the
// capture screens label (server/ui/captures.js). No DOM, so both can use it.
// `needed` fields are read again by the larger model when they are not sure.
export const JOB_FIELDS = Object.freeze([
  Object.freeze({ key: 'case_number', label: 'Case number', needed: true }),
  Object.freeze({ key: 'practice', label: 'Practice', needed: true }),
  Object.freeze({ key: 'dentist', label: 'Dentist', needed: false }),
  Object.freeze({ key: 'work', label: 'Work', needed: true }),
  Object.freeze({ key: 'teeth', label: 'Teeth', needed: false }),
  Object.freeze({ key: 'shade', label: 'Shade', needed: false }),
  Object.freeze({ key: 'due_date', label: 'Due date', needed: false }),
  Object.freeze({ key: 'notes', label: 'Notes', needed: false }),
]);

// Below this a needed field is read again (FLOW_READER_SURE_LINE can move
// that line), and the screens mark a value as not sure (amber).
export const SURE_LINE = 0.8;

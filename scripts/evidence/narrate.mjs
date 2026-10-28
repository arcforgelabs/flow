#!/usr/bin/env node
// Narration for a report highlight. One short sentence, spoken, not printed
// on the frame. The capture script plays the file under the clip.
//
//   python3 -m edge_tts  (voice en-AU-NatashaNeural)
//   node scripts/evidence/narrate.mjs r29 /tmp/r29.mp3
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const VOICE = 'en-AU-NatashaNeural';

// One spoken sentence per highlight. The ring shows where to look.
// Still frames are not the baseline; a report can pull a frame from the clip later.
export const LINES = Object.freeze({
  r27: 'When a job ships and its checks pass, Draft when ready makes the invoice.',
  r28: 'Each column on the board is a work stage, from Received through to Shipped.',
  r29: 'Flow can link an approved Xero invoice before anyone has paid it.',
  r30: 'The draft the automation made is already sitting on Ready.',
  r32: 'Flow keeps its own price, and shows when the Xero price is different.',
  r33: 'The job changed after the draft. Accept the change before you send.',
  r34: 'This stage change has to happen in Seazona. Flow waits for it.',
  r35: 'Group, sort and filter stay with this account after a reload.',
  r36: 'A sent invoice wears a Paid in Xero badge once Xero has the payment.',
  r37: 'Invite emails the person, and they show on the list as Invited.',
  r38: 'Reconcile finds the invoice that matches this job. Link them.',
  r39: 'Invoices move through Pending, Ready, Draft, Approved, Sent and Void.',
  r40: 'A payment recorded in Xero comes back onto the Flow invoice.',
  r41: 'Reconcile puts jobs and invoices in the one list.',
  r42: 'Pending holds the invoice until the case reference is on the job.',
  r43: 'Rules open as cards. Each card has its own page.',
  r44: 'Add a nested filter, and And joins the two conditions.',
  r45: 'Tick Request a response when the report needs a written reply.',
  r46: 'Show Shipped, Case and Practitioner as columns on the invoice list.',
  r47: 'Send to Xero keeps going. This job could not be confirmed, so it stayed Ready.',
  r48: 'This client is not in Xero yet. Create them from here.',
  r481: 'Seazona is connected, and the old missed-invoice alert is gone.',
  r49: 'Turn on Two-way edits, and a contact change goes either way.',
  next: 'Non-chargeable work stays in the lab, and Flow never bills it.',
});

export async function narrate(id, outPath) {
  const text = LINES[id];
  if (!text) throw new Error(`No narration for ${id}`);
  await exec('python3', ['-m', 'edge_tts', '--voice', VOICE, '--rate', '+8%', '--text', text, '--write-media', outPath]);
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', outPath]);
  return { path: outPath, seconds: Number(stdout.trim()), text };
}

const [id, outPath] = process.argv.slice(2);
if (id && outPath) {
  const spoken = await narrate(id, outPath);
  console.log(`${spoken.text} (${spoken.seconds.toFixed(1)}s)`);
}

// Capture (/captures): a photo of a handwritten lab form becomes a proposed
// job change (RFC #357, docs/DATA_MODEL.md "Storage"). One tap opens the
// phone's own camera. Reading runs on the server, so the person can shoot the
// next form at once. The tray lists the captures; a row opens the result
// sheet: the photo, the job, only the fields that change (old, then new;
// amber when the reader was not sure) and Apply at the foot. On a desk a
// photo can also be dropped or pasted on the page, and the sheet takes J, K
// and Enter.
import { lucide } from '/assets/ui/custom-fields.js';
import { JOB_FIELDS, SURE_LINE } from '/assets/ui/capture-fields.js';
import { isPhone } from '/assets/ui/mobile.js';
import qrcode from '/assets/vendor/qrcode.mjs';
import { recordBar, sidecar } from '/assets/ui/sidecar.js';

// The phone sends a smaller copy: about 1,600 px on the long side.
const LONG_SIDE = 1600;
const POLL_MS = 3000;
const POLL_MAX = 40;
const OFF = 'Capture needs a file store (FLOW_STORAGE).';
const STATE = { reading: 'Reading', ready: 'Ready', problem: 'Problem', done: 'Done' };
const TONE = { reading: 'info', ready: 'success', problem: 'warn', done: 'mute' };

const valueOf = (capture, key) => capture.read?.fields?.find((f) => f.key === key)?.value || '';

// One line for a capture: the practice and the work, else the case number.
function titleOf(capture) {
  const practice = valueOf(capture, 'practice');
  const work = valueOf(capture, 'work');
  const text = [practice, work].filter(Boolean).join(' · ') || valueOf(capture, 'case_number');
  if (text) return text;
  if (capture.state === 'reading') return 'Reading…';
  const problem = capture.problem ?? '';
  return problem ? problem[0].toUpperCase() + problem.slice(1) : 'Photo';
}

async function shrink(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob ?? file;
  } catch {
    // A type the browser cannot draw (HEIC on some browsers) goes as it is.
    return file;
  }
}

async function upload(file) {
  const body = await shrink(file);
  const token = await window.Clerk.session?.getToken();
  const res = await fetch('/api/captures', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': body.type || 'image/jpeg',
      'Idempotency-Key': crypto.randomUUID(),
      'X-Flow-Capture-Source': isPhone() ? 'phone' : 'desk',
    },
    body,
  });
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 404 ? OFF : answer.error || `HTTP ${res.status}`);
  return answer.capture;
}

// The Capture button, on Capture and in the Jobs toolbar: one tap opens the
// phone's own camera; a desk picks files. `send(files)` uploads each image
// and calls `added(capture)`, then `done()`.
export function captureButton(ui, { icon = false, added = () => {}, done = () => {} } = {}) {
  const { h, toast } = ui;
  const picker = h('input', { type: 'file', accept: 'image/*', hidden: true });
  if (isPhone()) picker.setAttribute('capture', 'environment');
  else picker.multiple = true;
  const button = icon
    ? h('button', { class: 'fx-btn fx-btn--ghost fx-btn--icon fx-capture__shoot', type: 'button', 'aria-label': 'Capture', title: 'Capture', onclick: () => picker.click() }, lucide(h, 'camera'))
    : h('button', { class: 'fx-btn fx-btn--primary fx-capture__shoot', type: 'button', onclick: () => picker.click() }, lucide(h, 'camera'), 'Capture');
  const send = async (files) => {
    for (const file of [...files].filter((f) => f.type.startsWith('image/'))) {
      try {
        added(await upload(file));
      } catch (error) {
        toast(error.message, 'danger', { stay: true });
      }
    }
    done();
  };
  picker.addEventListener('change', () => {
    const files = [...picker.files];
    picker.value = '';
    send(files);
  });
  return { nodes: [button, picker], send };
}

export async function renderCaptures(main, ui) {
  const { h, flow, toast, notice, listHead, listFrame } = ui;
  const shoot = captureButton(ui, {
    added: (capture) => { rows = [capture, ...rows]; draw(); },
    done: () => { polls = 0; load(); },
  });
  const usePhone = h('button', { class: 'fx-btn fx-captures__phone', type: 'button', onclick: () => {
    // Start from the origin: never carry a query, capture id or signed key.
    const url = new URL('/captures', location.origin).href;
    const code = qrcode(0, 'M');
    code.addData(url);
    code.make();
    const image = h('img', { class: 'fx-captures__qr', src: code.createDataURL(6, 24), alt: 'Scan to open Captures on your phone' });
    ui.dialog({ title: 'Use phone', confirm: 'Done', body: h('div', { class: 'fx-fields' }, image, h('a', { href: url }, url), h('p', { class: 'fx-dim' }, 'Sign in to Flow on your phone.')) });
  } }, 'Use phone');
  const settings = ui.me?.person.role === 'owner' ? h('a', { class: 'fx-btn', href: '/capture-settings' }, 'Settings') : null;
  const head = listHead('Captures', { actions: [...shoot.nodes, usePhone, settings].filter(Boolean) });
  const list = h('ul', { class: 'fx-captures', 'aria-label': 'Captures' });
  const frame = listFrame(main, list);
  const panel = sidecar(h, { label: 'Capture result' });
  const workspace = h('div', { class: 'fx-captures__workspace' }, frame.element, panel.element);
  main.append(...head.nodes, workspace);
  let selected = null;
  let request = 0;
  let closeSheet = () => {};


  let rows = [];
  let labels = new Map(JOB_FIELDS.map((f) => [f.key, f.label]));
  let polls = 0;
  let timer = null;

  const draw = () => {
    const ready = rows.filter((c) => c.state === 'ready').length;
    frame.count(ready ? `${ready} ready` : '');
    list.replaceChildren(...(rows.length ? rows.map((capture) => h('li', {},
      h('button', { class: 'fx-captures__row', type: 'button', 'aria-current': capture.id === selected ? 'true' : null, disabled: capture.state === 'reading', onclick: () => openSheet(capture.id) },
        h('span', { class: 'fx-captures__title', title: titleOf(capture) }, titleOf(capture)),
        h('span', { class: 'fx-status', 'data-tone': TONE[capture.state] }, STATE[capture.state])))) : [h('li', { class: 'fx-empty' }, 'No captures.')]));
  };

  async function load() {
    try {
      ({ captures: rows } = await flow('/api/captures'));
      draw();
    } catch (error) {
      const off = error.status === 404;
      list.replaceChildren(h('li', {}, notice(off ? OFF : error.message, off ? 'warn' : 'danger', off ? 'Off.' : null)));
      return;
    }
    clearTimeout(timer);
    if (rows.some((c) => c.state === 'reading') && polls < POLL_MAX && frame.element.isConnected) {
      polls += 1;
      timer = setTimeout(load, POLL_MS);
    }
  }

  // A desk: a photo dropped on the list or pasted on the page is a capture.
  // `main` stays across pages, so the listeners hang on this page's frame.
  frame.element.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
  frame.element.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    shoot.send(event.dataTransfer.files);
  });
  const paste = (event) => {
    if (!frame.element.isConnected) { document.removeEventListener('paste', paste); return; }
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length && !document.querySelector('dialog[open]')) shoot.send(files);
  };
  document.addEventListener('paste', paste);

  // The result sheet: beside the list on a desk, a dialog on smaller screens (the
  // job panel's layout: record bar, body, the action fixed at the foot).
  async function openSheet(id) {
    const ticket = ++request;
    let capture;
    try {
      ({ capture } = await flow(`/api/captures/${id}`));
    } catch (error) {
      toast(error.message, 'danger');
      return;
    }
    if (ticket !== request || !workspace.isConnected) return;
    closeSheet();
    selected = id;
    draw();
    const desk = matchMedia('(min-width: 1024px)').matches;
    const element = h(desk ? 'section' : 'dialog', { class: `${desk ? '' : 'fx-dialog '}fx-task fx-capture`, 'aria-label': 'Capture' });
    const close = () => {
      if (desk) panel.close();
      else { element.close(); element.remove(); }
      selected = null;
      draw();
    };
    closeSheet = close;
    const at = rows.findIndex((c) => c.id === id);
    // The next capture that has a result; one still reading is skipped.
    const step = (delta) => {
      for (let i = at + delta; i >= 0 && i < rows.length; i += delta) {
        if (rows[i].state === 'reading') continue;
        close();
        openSheet(rows[i].id);
        return;
      }
    };
    const proposal = capture.proposal ?? { changes: [] };
    const match = capture.match ?? { outcome: 'none', jobs: [] };
    const job = match.jobs.find((j) => j.jobId === proposal.jobId) ?? null;
    const jobLine = job
      ? `${job.caseRef ? `Job ${job.caseRef}` : job.jobId} · ${job.clientName ?? ''}`
      : proposal.action === 'create' ? 'New job' : 'Pick a job';

    // A field the work system owns: Apply leaves it; the person changes it
    // there (until a two-way sync can send it, #357).
    const system = proposal.action === 'update' && proposal.jobId ? proposal.jobId.split(':')[0] : null;
    const systemName = system ? system[0].toUpperCase() + system.slice(1) : null;
    const elsewhere = (change) => systemName && !change.field.startsWith('custom_');
    const changeRow = (change) => h('div', { class: 'fx-capture__change', 'data-unsure': change.sure != null && change.sure < SURE_LINE ? 'true' : 'false' },
      h('span', { class: 'fx-capture__field' }, labels.get(change.field) ?? change.field,
        elsewhere(change) ? h('span', { class: 'fx-capture__where', title: `Change this in ${systemName}` }, systemName) : null),
      h('span', { class: 'fx-capture__from' }, change.from || '–'),
      h('span', { class: 'fx-capture__arrow', 'aria-hidden': 'true' }, '→'),
      h('span', { class: 'fx-capture__to' }, change.to));

    const decide = async (decision) => {
      try {
        await flow(`/api/captures/${id}/decision`, { method: 'POST', body: JSON.stringify({ decision }) });
        toast(decision === 'applied' ? 'Applied.' : 'Discarded.', 'success');
        close();
        load();
      } catch (error) {
        toast(error.message, 'danger', { stay: true });
      }
    };

    const pickJob = async () => {
      const chosen = await ui.pickOne({
        title: 'Other job', label: 'Jobs', find: 'Find', empty: 'No jobs.', confirm: 'Use',
        load: async () => {
          const { jobs } = await flow('/api/invoicing/board');
          const near = new Map(match.jobs.map((j, i) => [j.jobId, i]));
          return jobs.map((j) => ({ ...j, jobId: `${j.sourceSystem}:${j.sourceJobRef}` }))
            .sort((a, b) => (near.get(a.jobId) ?? 99) - (near.get(b.jobId) ?? 99));
        },
        item: (j) => ({ value: j.jobId, title: j.clientName ?? j.jobId, meta: j.caseRef ? `Job ${j.caseRef}` : null }),
      });
      const jobId = chosen?.jobId ?? null;
      if (!jobId) return;
      try {
        await flow(`/api/captures/${id}/proposal`, { method: 'POST', body: JSON.stringify({ ...proposal, action: 'update', jobId }) });
        close();
        openSheet(id);
      } catch (error) {
        toast(error.message, 'danger');
      }
    };

    // A capture the reader could not read: type the fields that find the job.
    const typeIt = () => {
      const inputs = ['case_number', 'practice', 'work'].map((key) => h('input', { class: 'fx-input', name: key, 'aria-label': labels.get(key), placeholder: labels.get(key) }));
      const form = h('form', { class: 'fx-fields', onsubmit: async (event) => {
        event.preventDefault();
        const fields = Object.fromEntries(inputs.map((input) => [input.name, input.value.trim()]).filter(([, v]) => v));
        try {
          await flow(`/api/captures/${id}/match`, { method: 'POST', body: JSON.stringify({ fields }) });
          close();
          openSheet(id);
        } catch (error) {
          toast(error.message, 'danger');
        }
      } }, inputs, h('button', { class: 'fx-btn', type: 'submit' }, 'Find job'));
      return form;
    };

    const ready = capture.state === 'ready';
    const actions = ready ? [
      h('button', { class: 'fx-btn', type: 'button', onclick: () => decide('discarded') }, 'Discard'),
      match.jobs.length || proposal.action === 'update' ? h('button', { class: 'fx-btn', type: 'button', onclick: pickJob }, 'Other job') : null,
      h('button', { class: 'fx-btn fx-btn--primary', type: 'button', autofocus: true, disabled: proposal.action === 'update' && !proposal.jobId, onclick: () => decide('applied') }, 'Apply'),
    ] : capture.state === 'problem' ? [h('button', { class: 'fx-btn', type: 'button', onclick: () => decide('discarded') }, 'Discard')] : [];

    element.append(
      recordBar(h, {
        title: jobLine, label: 'Capture', onBack: close,
        prev: { label: 'Previous capture', disabled: at <= 0, onclick: () => step(-1) },
        next: { label: 'Next capture', disabled: at < 0 || at >= rows.length - 1, onclick: () => step(1) },
      }),
      h('div', { class: 'fx-task__grid' }, h('div', { class: 'fx-task__main' },
        h('header', { class: 'fx-task__head' }, h('span'), h('div', { class: 'fx-task__tools' },
          h('button', { class: 'fx-btn fx-btn--ghost fx-btn--icon', type: 'button', 'aria-label': 'Close', title: 'Close', onclick: close }, '✕'))),
        capture.link ? h('img', { class: 'fx-capture__photo', src: capture.link.url, alt: 'Form photo' }) : null,
        h('h2', { class: 'fx-task__title' }, jobLine),
        capture.state === 'problem' ? notice(capture.problem, 'warn', null, { short: capture.problem }) : null,
        capture.state === 'problem' ? typeIt() : null,
        ready && proposal.changes.length ? h('div', { class: 'fx-capture__changes' }, proposal.changes.map(changeRow)) : null,
        ready && !proposal.changes.length ? h('p', { class: 'fx-dim' }, 'No change.') : null,
        h('div', { class: 'fx-task__actions' }, actions))));
    element.addEventListener('click', (event) => { if (!desk && event.target === element) close(); });
    // Keys: J next, K previous (not while typing). Apply has the focus, so
    // Enter applies.
    element.addEventListener('keydown', (event) => {
      if (event.target.closest('input, textarea, select') || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === 'Escape' && desk) { close(); return; }
      if (event.key !== 'j' && event.key !== 'k') return;
      event.preventDefault();
      step(event.key === 'j' ? 1 : -1);
    });
    element.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    element.addEventListener('close', () => element.remove());
    if (desk) {
      panel.show(element);
      (element.querySelector('[autofocus]') ?? element.querySelector('button'))?.focus({ preventScroll: true });
    } else {
      document.body.append(element);
      element.showModal();
    }
  }

  const width = matchMedia('(min-width: 1024px)');
  const resize = () => {
    if (!workspace.isConnected) { width.removeEventListener('change', resize); return; }
    const id = selected;
    if (id) openSheet(id);
  };
  width.addEventListener('change', resize);

  try {
    const { fields } = await flow('/api/custom-fields');
    labels = new Map([...labels, ...fields.map((f) => [`custom_${f.id}`, f.name])]);
  } catch {
    // The standard labels still show; a custom field shows its key.
  }
  await load();
}

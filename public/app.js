const form = document.querySelector('#recordForm');
const fieldNames = [
  'name', 'vialQuantity', 'price', 'dilution', 'concentration', 'doseMg', 'doseMl',
  'syringeUnits', 'lot', 'reconstitutedDate', 'beyondUseDate', 'storage', 'notes',
];

const ui = {
  recordList: document.querySelector('#recordList'),
  emptyList: document.querySelector('#emptyList'),
  recordCount: document.querySelector('#recordCount'),
  search: document.querySelector('#recordSearch'),
  editorEmpty: document.querySelector('#editorEmpty'),
  editorEyebrow: document.querySelector('#editorEyebrow'),
  editorTitle: document.querySelector('#editorTitle'),
  unsaved: document.querySelector('#unsavedIndicator'),
  save: document.querySelector('#saveRecordButton'),
  delete: document.querySelector('#deleteRecordButton'),
  formMessage: document.querySelector('#formMessage'),
  quantity: document.querySelector('#printQuantity'),
  labelsPerStock: document.querySelector('#labelsPerStock'),
  summary: document.querySelector('#printSummary'),
  preview: document.querySelector('#labelPreview'),
  outputOrientation: document.querySelector('#outputOrientation'),
  mediaConfirmed: document.querySelector('#mediaConfirmed'),
  print: document.querySelector('#printButton'),
  printHelp: document.querySelector('#printHelp'),
  printerChip: document.querySelector('#printerStatus'),
  printerTitle: document.querySelector('#printerTitle'),
  printerDetails: document.querySelector('#printerDetails'),
  printerTarget: document.querySelector('#printerTarget'),
  printerSelect: document.querySelector('#printerSelect'),
  discoverPrinters: document.querySelector('#discoverPrintersButton'),
  selectPrinter: document.querySelector('#selectPrinterButton'),
  printerDiscoveryMessage: document.querySelector('#printerDiscoveryMessage'),
  refreshPrinter: document.querySelector('#refreshPrinterButton'),
  jobs: document.querySelector('#jobList'),
  toast: document.querySelector('#toast'),
};

const state = {
  records: [],
  jobs: [],
  selectedId: null,
  baseline: null,
  printer: null,
  selectedPrinterHost: null,
  discoveredPrinters: [],
  saving: false,
  printing: false,
  checkingPrinter: false,
  discoveringPrinters: false,
  selectingPrinter: false,
};

let toastTimer;

function currentDraft() {
  return Object.fromEntries(fieldNames.map((name) => [name, form.elements.namedItem(name).value.trim()]));
}

function sameDraft(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function setMessage(message = '', kind = '') {
  ui.formMessage.textContent = message;
  ui.formMessage.className = `form-message${kind ? ` ${kind}` : ''}`;
}

function showToast(message, kind = '') {
  clearTimeout(toastTimer);
  ui.toast.textContent = message;
  ui.toast.className = `toast visible${kind ? ` ${kind}` : ''}`;
  toastTimer = setTimeout(() => { ui.toast.className = 'toast'; }, 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function selectedRecord() {
  return state.records.find((record) => Number(record.id) === Number(state.selectedId)) || null;
}

function hasUnsavedChanges() {
  return Boolean(state.baseline && !sameDraft(currentDraft(), state.baseline));
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

function renderRecords() {
  const search = ui.search.value.trim().toLocaleLowerCase();
  const visible = state.records.filter((record) =>
    fieldNames.some((name) => String(record[name] || '').toLocaleLowerCase().includes(search)));
  ui.recordList.replaceChildren();
  ui.recordList.hidden = visible.length === 0;
  ui.emptyList.hidden = visible.length !== 0;
  if (!state.records.length) {
    ui.emptyList.querySelector('strong').textContent = 'No records yet';
    ui.emptyList.querySelector('span').textContent = 'Add a record to begin building your label library.';
  } else if (!visible.length) {
    ui.emptyList.querySelector('strong').textContent = 'No matches';
    ui.emptyList.querySelector('span').textContent = 'Try a different peptide name or search term.';
  }

  for (const record of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `record-item${Number(record.id) === Number(state.selectedId) ? ' selected' : ''}`;
    button.setAttribute('aria-current', Number(record.id) === Number(state.selectedId) ? 'true' : 'false');
    const initial = document.createElement('span');
    initial.className = 'record-initial';
    initial.textContent = record.name.trim().slice(0, 1).toUpperCase();
    const text = document.createElement('span');
    text.className = 'record-text';
    const name = document.createElement('span');
    name.className = 'record-name';
    name.textContent = record.name;
    const meta = document.createElement('span');
    meta.className = 'record-meta';
    meta.textContent = [record.vialQuantity, record.concentration].filter(Boolean).join(' · ') || 'No amount or concentration';
    const arrow = document.createElement('span');
    arrow.className = 'record-arrow';
    arrow.textContent = '›';
    text.append(name, meta);
    button.append(initial, text, arrow);
    button.addEventListener('click', () => selectRecord(record.id));
    ui.recordList.append(button);
  }
  ui.recordCount.textContent = `${state.records.length} record${state.records.length === 1 ? '' : 's'}`;
}

function setEditor(record = null) {
  form.reset();
  for (const name of fieldNames) form.elements.namedItem(name).value = record?.[name] || '';
  state.selectedId = record ? Number(record.id) : null;
  state.baseline = currentDraft();
  ui.editorEmpty.hidden = true;
  form.hidden = false;
  ui.editorEyebrow.textContent = record ? 'SAVED RECORD' : 'NEW RECORD';
  ui.editorTitle.textContent = record?.name || 'Peptide details';
  ui.delete.hidden = !record;
  ui.unsaved.hidden = true;
  setMessage();
  renderRecords();
  updatePreview();
  updatePrintControls();
}

function mayDiscardChanges() {
  return !hasUnsavedChanges() || window.confirm('Discard your unsaved changes?');
}

function selectRecord(id) {
  if (!mayDiscardChanges()) return;
  const record = state.records.find((item) => Number(item.id) === Number(id));
  if (record) setEditor(record);
}

function startNewRecord() {
  if (!mayDiscardChanges()) return;
  setEditor(null);
  form.elements.namedItem('name').focus();
}

function previewLines(record, limit = 6) {
  const lines = [];
  const amount = [record.vialQuantity && `Vial ${record.vialQuantity}`, record.concentration && `Conc ${record.concentration}`].filter(Boolean).join(' | ');
  if (amount) lines.push(amount);
  if (record.dilution) lines.push(`Dilution ${record.dilution}`);
  if (record.doseMg) lines.push(`Dose ${record.doseMg}`);
  const doseVolume = [record.doseMl && `${record.doseMl} mL`, record.syringeUnits && `${record.syringeUnits} U-100 marks`].filter(Boolean).join(' | ');
  if (doseVolume) lines.push(doseVolume);
  const lotDate = [record.lot && `Lot ${record.lot}`, record.beyondUseDate && `BUD ${formatDate(record.beyondUseDate)}`].filter(Boolean).join(' | ');
  if (lotDate) lines.push(lotDate);
  const preparedStorage = [record.reconstitutedDate && `Recon ${formatDate(record.reconstitutedDate)}`, record.storage && `Store ${record.storage}`].filter(Boolean).join(' | ');
  if (preparedStorage) lines.push(preparedStorage);
  if (record.notes) lines.push(`Note ${record.notes}`);
  return lines.slice(0, limit);
}

function updatePreview() {
  const record = form.hidden ? selectedRecord() : currentDraft();
  const count = Number(ui.labelsPerStock.value) || 4;
  ui.preview.replaceChildren();
  for (let index = 0; index < count; index += 1) {
    const band = document.createElement('div');
    band.className = 'preview-band';
    const name = document.createElement('span');
    name.className = 'preview-name';
    name.textContent = record?.name || 'Peptide name';
    band.append(name);
    for (const textValue of previewLines(record || {}, 6)) {
      const line = document.createElement('span');
      line.className = 'preview-line';
      line.textContent = textValue;
      band.append(line);
    }
    ui.preview.append(band);
  }

  const quantity = Number(ui.quantity.value);
  const stockCount = Number.isInteger(quantity) && quantity > 0 ? Math.ceil(quantity / count) : 0;
  ui.summary.textContent = stockCount
    ? `${quantity} cut strip${quantity === 1 ? '' : 's'} · ${stockCount} printer label${stockCount === 1 ? '' : 's'}`
    : 'Enter a quantity from 1 to 250';
  updatePrintControls();
}

function setPrinterStatus(printer) {
  state.printer = printer;
  state.selectedPrinterHost = printer?.host || null;
  const usable = printer?.connected && printer?.ready && printer?.mediaReady;
  const connectedReady = printer?.connected && printer?.ready;
  const selected = Boolean(state.selectedPrinterHost);
  const chipClass = usable ? 'status-ready' : connectedReady ? 'status-warn' : selected ? 'status-offline' : 'status-warn';
  ui.printerChip.className = `printer-chip ${chipClass}`;
  ui.printerChip.lastElementChild.textContent = usable
    ? 'Printer ready'
    : !selected ? 'Select printer'
      : !printer?.connected ? 'Printer offline'
      : !printer.ready ? 'Printer not ready' : 'Media setup needed';
  ui.printerTitle.textContent = printer?.model || 'Zebra printer';
  ui.printerTarget.textContent = selected
    ? `${state.selectedPrinterHost} · raw ZPL / port ${printer?.port || 9100}`
    : `No printer selected · raw ZPL / port ${printer?.port || 9100}`;

  ui.printerDetails.replaceChildren();
  ui.outputOrientation.replaceChildren();
  const canvasTitle = document.createElement('strong');
  canvasTitle.textContent = 'Physical print canvas';
  const canvasText = document.createElement('span');
  const dot = document.createElement('span');
  dot.className = `status-dot ${usable ? 'status-dot-ready' : connectedReady ? 'status-dot-warn' : 'status-dot-offline'}`;
  const message = document.createElement('span');
  if (!selected) {
    message.textContent = 'Find and select a Zebra printer on the local network.';
    canvasText.textContent = 'Select a printer to load its reported print width and feed length.';
  } else if (!printer?.connected) {
    const unavailable = printer?.error || 'Could not read the printer status.';
    message.textContent = unavailable;
    canvasText.textContent = 'Waiting for the live printer report…';
  } else if (!printer.ready) {
    message.textContent = 'The printer is online but is not reporting READY.';
    canvasText.textContent = 'Printer is online; its report does not show READY.';
  } else if (!printer.mediaReady) {
    const width = printer.printWidthDots == null ? 'unknown' : printer.printWidthDots;
    const length = printer.labelLengthDots == null ? 'unknown' : printer.labelLengthDots;
    message.textContent = `The printer reported ${width} × ${length} dots, but its print width or label length could not be read.`;
    canvasText.textContent = `Report: ${width} print-width × ${length} feed dots; dimensions need to be readable.`;
  } else {
    const orientation = printer.orientation || (printer.printWidthDots >= printer.labelLengthDots ? 'landscape' : 'portrait');
    const strips = Number(ui.labelsPerStock.value) || 4;
    const transform = orientation === 'landscape'
      ? `Portrait design rotates 90°; ${strips}-up cuts run across the reported print width.`
      : `Portrait design prints upright; ${strips}-up cuts run along the reported feed length.`;
    message.textContent = `Ready · ${printer.printWidthDots} print-width × ${printer.labelLengthDots} feed dots (${orientation}), per printer report. ${transform}`;
    canvasText.textContent = `${printer.printWidthDots} dots across × ${printer.labelLengthDots} dots feed · ${orientation}. ${transform}`;
  }
  ui.outputOrientation.append(canvasTitle, canvasText);
  ui.printerDetails.append(dot, message);
  renderPrinterChoices();
  updatePrinterChoiceControls();
  updatePrintControls();
}

function renderPrinterChoices() {
  const previousValue = ui.printerSelect.value;
  ui.printerSelect.replaceChildren();
  const currentHost = state.selectedPrinterHost;
  const discoveredHosts = new Set(state.discoveredPrinters.map((printer) => printer.host));
  if (currentHost && !discoveredHosts.has(currentHost)) {
    const option = document.createElement('option');
    option.value = currentHost;
    option.textContent = `${state.printer?.model || 'Selected Zebra printer'} — ${currentHost}`;
    ui.printerSelect.append(option);
  }
  for (const printer of state.discoveredPrinters) {
    const option = document.createElement('option');
    option.value = printer.host;
    const readiness = printer.ready ? 'READY' : 'not READY';
    option.textContent = `${printer.model || 'Zebra printer'} — ${printer.host} · ${readiness}`;
    ui.printerSelect.append(option);
  }
  const options = [...ui.printerSelect.options];
  if (!options.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = state.discoveringPrinters ? 'Searching…' : 'Find printers on network';
    ui.printerSelect.append(option);
  }
  const available = new Set([...ui.printerSelect.options].map((option) => option.value));
  const nextValue = available.has(previousValue) && previousValue
    ? previousValue
    : available.has(currentHost) && currentHost
      ? currentHost
      : state.discoveredPrinters.length === 1 ? state.discoveredPrinters[0].host : '';
  ui.printerSelect.value = nextValue;
}

function updatePrinterChoiceControls() {
  ui.discoverPrinters.disabled = state.discoveringPrinters || state.selectingPrinter;
  ui.discoverPrinters.textContent = state.discoveringPrinters ? 'Searching…' : 'Find printers';
  ui.selectPrinter.disabled = state.discoveringPrinters || state.selectingPrinter
    || !ui.printerSelect.value || ui.printerSelect.value === state.selectedPrinterHost;
  ui.selectPrinter.textContent = state.selectingPrinter ? 'Selecting…' : 'Use selected';
}

async function discoverPrinters() {
  if (state.discoveringPrinters || state.selectingPrinter) return;
  state.discoveringPrinters = true;
  ui.printerDiscoveryMessage.textContent = 'Scanning private local IPv4 networks for Zebra printers with raw ZPL on port 9100…';
  renderPrinterChoices();
  updatePrinterChoiceControls();
  try {
    const result = await api('/api/printers/discover', { method: 'POST' });
    state.discoveredPrinters = result.printers;
    renderPrinterChoices();
    const scopeText = result.scopes.join(', ');
    ui.printerDiscoveryMessage.textContent = result.printers.length
      ? `Found ${result.printers.length} Zebra printer${result.printers.length === 1 ? '' : 's'} on ${scopeText} (${result.scanned} addresses checked). Choose one, then select it.`
      : `No Zebra ZPL printers found on ${scopeText} (${result.scanned} addresses checked).`;
  } catch (error) {
    ui.printerDiscoveryMessage.textContent = error.message;
  } finally {
    state.discoveringPrinters = false;
    renderPrinterChoices();
    updatePrinterChoiceControls();
  }
}

async function useSelectedPrinter() {
  const host = ui.printerSelect.value;
  if (!host || state.selectingPrinter || host === state.selectedPrinterHost) return;
  state.selectingPrinter = true;
  updatePrinterChoiceControls();
  ui.mediaConfirmed.checked = false;
  updatePrintControls();
  try {
    const result = await api('/api/printer/select', {
      method: 'POST',
      body: JSON.stringify({ host }),
    });
    setPrinterStatus(result.printer);
    ui.printerDiscoveryMessage.textContent = `Using ${result.printer.model || 'Zebra printer'} at ${result.selectedHost}.`;
  } catch (error) {
    ui.printerDiscoveryMessage.textContent = error.message;
  } finally {
    state.selectingPrinter = false;
    renderPrinterChoices();
    updatePrinterChoiceControls();
    updatePrintControls();
  }
}

function updatePrintControls() {
  const quantity = Number(ui.quantity.value);
  const validQuantity = Number.isInteger(quantity) && quantity >= 1 && quantity <= 250;
  const dirty = !form.hidden && hasUnsavedChanges();
  const recordSaved = Boolean(selectedRecord()) && !dirty;
  const printerReady = Boolean(state.printer?.connected && state.printer?.ready && state.printer?.mediaReady);
  const mediaConfirmed = ui.mediaConfirmed.checked;
  ui.print.disabled = !(recordSaved && validQuantity && mediaConfirmed && printerReady) || state.printing;

  if (state.printing) ui.printHelp.textContent = 'Sending the label job to the Zebra printer…';
  else if (!selectedRecord()) ui.printHelp.textContent = 'Save a peptide record before printing.';
  else if (dirty) ui.printHelp.textContent = 'Save your changes before printing this record.';
  else if (!validQuantity) ui.printHelp.textContent = 'Enter a quantity from 1 to 250 individual vial labels.';
  else if (!mediaConfirmed) ui.printHelp.textContent = 'Verify the roll matches the physical canvas above and is calibrated, then confirm.';
  else if (!state.selectedPrinterHost) ui.printHelp.textContent = 'Find and select a printer on the local network before printing.';
  else if (!state.printer?.connected) ui.printHelp.textContent = 'Printer status is unavailable. Check the network connection and refresh.';
  else if (!state.printer.ready) ui.printHelp.textContent = 'The printer must report READY before printing.';
  else if (!state.printer.mediaReady) ui.printHelp.textContent = 'Refresh the printer report so the app can read its print width and label length.';
  else ui.printHelp.textContent = 'Ready. Each portrait-design strip is rotated as needed to match the live printer canvas.';

  ui.save.disabled = state.saving;
  ui.save.textContent = state.saving ? 'Saving…' : 'Save record';
}

function renderJobs() {
  ui.jobs.replaceChildren();
  if (!state.jobs.length) {
    const empty = document.createElement('p');
    empty.className = 'muted-empty';
    empty.textContent = 'No print jobs yet.';
    ui.jobs.append(empty);
    return;
  }
  for (const job of state.jobs) {
    const row = document.createElement('div');
    row.className = 'job-row';
    const details = document.createElement('div');
    details.className = 'job-details';
    const name = document.createElement('strong');
    name.textContent = job.peptideName;
    const meta = document.createElement('span');
    const created = new Date(job.createdAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    meta.textContent = `${job.quantity} cut strip${job.quantity === 1 ? '' : 's'} · ${job.stockLabels} printer label${job.stockLabels === 1 ? '' : 's'} · ${created}`;
    details.append(name, meta);
    const status = document.createElement('span');
    status.className = `job-status ${job.status === 'submitted' ? 'job-status-ok' : 'job-status-warn'}`;
    status.textContent = job.status === 'submitted' ? 'Sent' : job.status;
    if (job.error) status.title = job.error;
    row.append(details, status);
    ui.jobs.append(row);
  }
}

async function loadRecords() {
  const { records } = await api('/api/peptides');
  state.records = records;
  const selected = selectedRecord();
  if (selected) {
    state.selectedId = Number(selected.id);
  } else if (state.selectedId != null) {
    state.selectedId = null;
  }
  renderRecords();
  updatePrintControls();
}

async function loadJobs() {
  const { jobs } = await api('/api/jobs');
  state.jobs = jobs;
  renderJobs();
}

async function refreshPrinterStatus() {
  if (state.checkingPrinter) return;
  state.checkingPrinter = true;
  ui.refreshPrinter.disabled = true;
  try {
    const { printer } = await api('/api/status');
    setPrinterStatus(printer);
  } catch (error) {
    setPrinterStatus({
      connected: false, ready: false, mediaReady: false,
      host: state.selectedPrinterHost || '', port: state.printer?.port || 9100,
      model: state.printer?.model || '', error: error.message,
    });
  } finally {
    state.checkingPrinter = false;
    ui.refreshPrinter.disabled = false;
  }
}

form.addEventListener('input', () => {
  const dirty = hasUnsavedChanges();
  ui.unsaved.hidden = !dirty;
  ui.editorEyebrow.textContent = state.selectedId ? 'SAVED RECORD' : 'NEW RECORD';
  ui.editorTitle.textContent = currentDraft().name || 'Peptide details';
  setMessage();
  updatePreview();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.saving) return;
  state.saving = true;
  updatePrintControls();
  setMessage();
  try {
    const draft = currentDraft();
    const editing = state.selectedId != null;
    const result = await api(editing ? `/api/peptides/${state.selectedId}` : '/api/peptides', {
      method: editing ? 'PUT' : 'POST',
      body: JSON.stringify(draft),
    });
    await loadRecords();
    const saved = result.record;
    state.records = state.records.map((record) => Number(record.id) === Number(saved.id) ? saved : record);
    setEditor(saved);
    setMessage('Record saved on this computer.', 'success');
    showToast(`${saved.name} saved.`);
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    state.saving = false;
    updatePrintControls();
  }
});

ui.delete.addEventListener('click', async () => {
  const record = selectedRecord();
  if (!record || !window.confirm(`Delete “${record.name}” from the local library?`)) return;
  ui.delete.disabled = true;
  try {
    await api(`/api/peptides/${record.id}`, { method: 'DELETE' });
    state.records = state.records.filter((item) => Number(item.id) !== Number(record.id));
    state.selectedId = null;
    state.baseline = null;
    form.hidden = true;
    ui.editorEmpty.hidden = false;
    renderRecords();
    updatePreview();
    updatePrintControls();
    showToast(`${record.name} deleted.`);
  } catch (error) {
    setMessage(error.message, 'error');
  } finally {
    ui.delete.disabled = false;
  }
});

document.querySelector('#newRecordButton').addEventListener('click', startNewRecord);
document.querySelector('#emptyNewButton').addEventListener('click', startNewRecord);
ui.search.addEventListener('input', renderRecords);
ui.quantity.addEventListener('input', updatePreview);
ui.labelsPerStock.addEventListener('change', () => {
  updatePreview();
  if (state.printer) setPrinterStatus(state.printer);
});
ui.mediaConfirmed.addEventListener('change', updatePrintControls);
ui.refreshPrinter.addEventListener('click', refreshPrinterStatus);
ui.discoverPrinters.addEventListener('click', discoverPrinters);
ui.selectPrinter.addEventListener('click', useSelectedPrinter);
ui.printerSelect.addEventListener('change', updatePrinterChoiceControls);
document.querySelector('#backupButton').addEventListener('click', () => {
  window.location.assign('/api/backup');
});

ui.print.addEventListener('click', async () => {
  const record = selectedRecord();
  if (!record || ui.print.disabled || state.printing) return;
  state.printing = true;
  updatePrintControls();
  try {
    const result = await api('/api/print', {
      method: 'POST',
      body: JSON.stringify({
        recordId: record.id,
        quantity: Number(ui.quantity.value),
        labelsPerStock: Number(ui.labelsPerStock.value),
        mediaConfirmed: ui.mediaConfirmed.checked,
      }),
    });
    showToast(result.message, 'success');
    await Promise.all([loadJobs(), refreshPrinterStatus()]);
  } catch (error) {
    showToast(error.message, 'error');
    await Promise.all([loadJobs(), refreshPrinterStatus()]);
  } finally {
    state.printing = false;
    updatePrintControls();
  }
});

async function initialize() {
  renderJobs();
  updatePreview();
  const results = await Promise.allSettled([loadRecords(), loadJobs(), refreshPrinterStatus()]);
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) showToast(`Could not load saved app data: ${failure.reason.message}`, 'error');
  setInterval(refreshPrinterStatus, 30_000);
}

initialize();

import { spawn } from 'node:child_process';
import { createServer, get as httpGet } from 'node:http';
import { createConnection } from 'node:net';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

process.umask(0o077);

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
chmodSync(DATA_DIR, 0o700);

const HOST = '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '3036', 10);
const PRINTER_PORT = Number.parseInt(process.env.PRINTER_PORT || '9100', 10);
const VALID_UPS = new Set([3, 4]);
const MAX_PRINT_QUANTITY = 250;
const DISCOVERY_CONCURRENCY = 48;
const MAX_DISCOVERY_HOSTS = 1022;
const DB_PATH = join(DATA_DIR, 'vial-labels.sqlite');

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS peptides (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    vial_quantity TEXT NOT NULL DEFAULT '',
    dilution TEXT NOT NULL DEFAULT '',
    concentration TEXT NOT NULL DEFAULT '',
    dose_mg TEXT NOT NULL DEFAULT '',
    dose_ml TEXT NOT NULL DEFAULT '',
    syringe_units TEXT NOT NULL DEFAULT '',
    price TEXT NOT NULL DEFAULT '',
    lot TEXT NOT NULL DEFAULT '',
    reconstituted_date TEXT NOT NULL DEFAULT '',
    beyond_use_date TEXT NOT NULL DEFAULT '',
    storage TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY,
    peptide_id INTEGER REFERENCES peptides(id) ON DELETE SET NULL,
    peptide_name TEXT NOT NULL,
    quantity INTEGER NOT NULL,
    stock_labels INTEGER NOT NULL,
    labels_per_stock INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT NOT NULL DEFAULT '',
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);
const peptideSchema = new Set(db.prepare('PRAGMA table_info(peptides)').all().map((column) => column.name));
for (const [column, declaration] of [
  ['dose_mg', "TEXT NOT NULL DEFAULT ''"],
  ['syringe_units', "TEXT NOT NULL DEFAULT ''"],
  ['price', "TEXT NOT NULL DEFAULT ''"],
]) {
  if (!peptideSchema.has(column)) db.exec(`ALTER TABLE peptides ADD COLUMN ${column} ${declaration}`);
}
chmodSync(DB_PATH, 0o600);

const getSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const putSetting = db.prepare(`
  INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
const savedPrinterHost = getSetting.get('printer_host')?.value || '';
let selectedPrinterHost = savedPrinterHost || (process.env.PRINTER_HOST || '').trim();
if (!savedPrinterHost && selectedPrinterHost) {
  putSetting.run('printer_host', selectedPrinterHost, new Date().toISOString());
}
let lastDiscoveredHosts = new Set();

const COLUMNS = [
  ['name', 80],
  ['vialQuantity', 48],
  ['dilution', 48],
  ['concentration', 32],
  ['doseMg', 40],
  ['doseMl', 32],
  ['syringeUnits', 24],
  ['lot', 24],
  ['reconstitutedDate', 10],
  ['beyondUseDate', 10],
  ['storage', 40],
  ['notes', 60],
  ['price', 20],
];
const DB_COLUMN = {
  name: 'name',
  vialQuantity: 'vial_quantity',
  dilution: 'dilution',
  concentration: 'concentration',
  doseMg: 'dose_mg',
  doseMl: 'dose_ml',
  syringeUnits: 'syringe_units',
  lot: 'lot',
  reconstitutedDate: 'reconstituted_date',
  beyondUseDate: 'beyond_use_date',
  storage: 'storage',
  notes: 'notes',
  price: 'price',
};
const SELECT_COLUMNS = `id, name, vial_quantity AS vialQuantity, dilution,
  concentration, dose_mg AS doseMg, dose_ml AS doseMl,
  syringe_units AS syringeUnits, price,
  lot,
  reconstituted_date AS reconstitutedDate, beyond_use_date AS beyondUseDate,
  storage, notes, created_at AS createdAt, updated_at AS updatedAt`;
const getRecord = db.prepare(`SELECT ${SELECT_COLUMNS} FROM peptides WHERE id = ?`);
const listRecords = db.prepare(`SELECT ${SELECT_COLUMNS} FROM peptides ORDER BY name COLLATE NOCASE, id`);
const listJobs = db.prepare(`
  SELECT id, peptide_name AS peptideName, quantity, stock_labels AS stockLabels,
    labels_per_stock AS labelsPerStock, status, error, created_at AS createdAt
  FROM print_jobs ORDER BY id DESC LIMIT 12
`);

function now() {
  return new Date().toISOString();
}

function normalizeRecord(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Provide a record to save.');
  }
  const record = {};
  for (const [key, maxLength] of COLUMNS) {
    const value = input[key] == null ? '' : String(input[key]).trim();
    if (value.length > maxLength) {
      throw new HttpError(400, `${fieldLabel(key)} must be ${maxLength} characters or fewer.`);
    }
    record[key] = value;
  }
  if (!record.name) throw new HttpError(400, 'Peptide name is required.');
  for (const key of ['reconstitutedDate', 'beyondUseDate']) {
    if (record[key]) {
      const parsed = new Date(`${record[key]}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(record[key])
        || Number.isNaN(parsed.valueOf())
        || parsed.toISOString().slice(0, 10) !== record[key]) {
        throw new HttpError(400, `${fieldLabel(key)} must be a valid date.`);
      }
    }
  }
  return record;
}

function fieldLabel(key) {
  return {
    name: 'Peptide name', vialQuantity: 'Vial quantity', dilution: 'Dilution',
    concentration: 'Concentration', doseMg: 'Dose amount', doseMl: 'Dose volume (mL)',
    syringeUnits: 'U-100 syringe marks', price: 'Cost',
    lot: 'Lot / batch', reconstitutedDate: 'Reconstituted date',
    beyondUseDate: 'Beyond-use date', storage: 'Storage instruction', notes: 'Note',
  }[key] || key;
}

function rowToRecord(row) {
  return row ? { ...row } : null;
}

function sendJson(res, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const message = status === 500 ? 'The app hit an unexpected error.' : error.message;
  if (status === 500) console.error(error);
  sendJson(res, status, { error: message });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req, limit = 80_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function checkBrowserOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  const expected = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
  if (!expected.has(origin)) throw new HttpError(403, 'This local app only accepts requests from its own page.');
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

function getText(url, timeoutMs = 2400) {
  return new Promise((resolveText, reject) => {
    const req = httpGet(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolveText(Buffer.concat(chunks).toString('latin1')));
    });
    req.on('timeout', () => req.destroy(new Error('Printer request timed out.')));
    req.on('error', reject);
  });
}

async function getPrinterStatus(host = selectedPrinterHost, timeoutMs = 2400) {
  if (!host) {
    return {
      connected: false,
      ready: false,
      mediaReady: false,
      orientation: null,
      host: '',
      port: PRINTER_PORT,
      model: '',
      printWidthDots: null,
      labelLengthDots: null,
      error: 'No printer selected. Find printers on the network to choose one.',
    };
  }
  try {
    const [homeHtml, configHtml] = await Promise.all([
      getText(`http://${host}/`, timeoutMs),
      getText(`http://${host}/config.html`, timeoutMs),
    ]);
    const ready = /Status:\s*<FONT[^>]*>READY<\/FONT>/i.test(homeHtml);
    const config = htmlToText(configHtml);
    const widthMatch = config.match(/(\d+)\s+PRINT WIDTH/i);
    const lengthMatch = config.match(/(\d+)\s+LABEL LENGTH/i);
    const printWidthDots = widthMatch ? Number(widthMatch[1]) : null;
    const labelLengthDots = lengthMatch ? Number(lengthMatch[1]) : null;
    const mediaReady = Number.isFinite(printWidthDots) && printWidthDots > 0
      && Number.isFinite(labelLengthDots) && labelLengthDots > 0;
    const model = (homeHtml.match(/<H1>[\s\S]*?<\/H1>/i)?.[0] || '')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      connected: true,
      ready,
      mediaReady,
      orientation: mediaReady ? (printWidthDots >= labelLengthDots ? 'landscape' : 'portrait') : null,
      host,
      port: PRINTER_PORT,
      model,
      zebraIdentified: /zebra|zt\s?-?\d{3,4}/i.test(`${model} ${homeHtml}`),
      printWidthDots,
      labelLengthDots,
      error: '',
    };
  } catch (error) {
    return {
      connected: false,
      ready: false,
      mediaReady: false,
      orientation: null,
      host,
      port: PRINTER_PORT,
      model: '',
      zebraIdentified: false,
      printWidthDots: null,
      labelLengthDots: null,
      error: `Could not reach the printer web status: ${error.message}`,
    };
  }
}

function ipv4ToNumber(address) {
  const octets = String(address).split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets.reduce((value, octet) => (value * 256) + octet, 0);
}

function numberToIpv4(value) {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / (2 ** shift)) % 256).join('.');
}

function isPrivateIpv4(address) {
  const value = ipv4ToNumber(address);
  if (value == null) return false;
  const first = Math.floor(value / 16_777_216);
  const second = Math.floor(value / 65_536) % 256;
  return first === 10 || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function netmaskPrefix(netmask) {
  const value = ipv4ToNumber(netmask);
  if (value == null) return null;
  const bits = value.toString(2).padStart(32, '0');
  if (!/^1*0*$/.test(bits)) return null;
  return (bits.match(/^1*/) || [''])[0].length;
}

function discoveryTargets() {
  const targets = new Set();
  const scopes = [];
  const interfaces = networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (/^(lo|docker|podman|br-|veth|virbr|vmnet|tailscale|tun|tap|wg)/i.test(name)) continue;
    for (const address of addresses || []) {
      if ((address.family !== 'IPv4' && address.family !== 4) || address.internal || !isPrivateIpv4(address.address)) continue;
      const hostNumber = ipv4ToNumber(address.address);
      let prefix = netmaskPrefix(address.netmask);
      if (hostNumber == null || prefix == null || prefix > 30) continue;
      let blockSize = 2 ** (32 - prefix);
      if (blockSize - 2 > MAX_DISCOVERY_HOSTS) {
        prefix = 24;
        blockSize = 256;
      }
      const network = Math.floor(hostNumber / blockSize) * blockSize;
      const broadcast = network + blockSize - 1;
      const scope = `${name}: ${numberToIpv4(network)}/${prefix}`;
      if (!scopes.includes(scope)) scopes.push(scope);
      for (let candidate = network + 1; candidate < broadcast; candidate += 1) {
        if (candidate !== hostNumber) targets.add(numberToIpv4(candidate));
      }
    }
  }
  if (!targets.size) {
    throw new HttpError(503, 'No private IPv4 LAN interface was available to scan.');
  }
  return { targets: [...targets].slice(0, MAX_DISCOVERY_HOSTS), scopes };
}

function hasRawZplPort(host, timeoutMs = 450) {
  return new Promise((resolveProbe) => {
    let settled = false;
    const socket = createConnection({ host, port: PRINTER_PORT });
    const finish = (available) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveProbe(available);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function discoverPrinters() {
  const { targets, scopes } = discoveryTargets();
  const probed = await mapWithConcurrency(targets, DISCOVERY_CONCURRENCY, async (host) => {
    if (!await hasRawZplPort(host)) return null;
    const status = await getPrinterStatus(host, 1100);
    if (!status.connected || !status.zebraIdentified) return null;
    return status;
  });
  const printers = probed.filter(Boolean).sort((left, right) => left.host.localeCompare(right.host, undefined, { numeric: true }));
  lastDiscoveredHosts = new Set(printers.map((printer) => printer.host));
  return { printers, scanned: targets.length, scopes };
}

function dateForLabel(isoDate) {
  if (!isoDate) return '';
  const [year, month, day] = isoDate.split('-');
  return `${month}/${day}/${year}`;
}

function zplSafe(value) {
  const bytes = Buffer.from(String(value ?? '').replace(/[\r\n]+/g, ' ').trim(), 'utf8');
  let out = '';
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7d && byte !== 0x5c && byte !== 0x5e) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(16).padStart(2, '0').toUpperCase()}`;
  }
  return out;
}

function textField(x, y, value, {
  height = 14,
  width = 11,
  maxLines = 1,
  orientation = 'N',
  blockWidth = 580,
} = {}) {
  if (!value) return '';
  return `^FO${x},${y}^A0${orientation},${height},${width}^FB${blockWidth},${maxLines},1,L,0^FH\\^FD${zplSafe(value)}^FS\n`;
}

function bandLines(record) {
  const lines = [];
  const amountAndConcentration = [
    record.vialQuantity && `Vial ${record.vialQuantity}`,
    record.concentration && `Conc ${record.concentration}`,
  ].filter(Boolean).join('  |  ');
  if (amountAndConcentration) lines.push(amountAndConcentration);
  if (record.dilution) lines.push(`Dilution ${record.dilution}`);
  if (record.doseMg) lines.push(`Dose ${record.doseMg}`);
  const volumeAndMarks = [
    record.doseMl && `${record.doseMl} mL`,
    record.syringeUnits && `${record.syringeUnits} U-100 marks`,
  ].filter(Boolean).join('  |  ');
  if (volumeAndMarks) lines.push(volumeAndMarks);
  const lotAndDate = [
    record.lot && `Lot ${record.lot}`,
    record.beyondUseDate && `BUD ${dateForLabel(record.beyondUseDate)}`,
  ].filter(Boolean).join('  |  ');
  if (lotAndDate) lines.push(lotAndDate);
  const preparedAndStorage = [
    record.reconstitutedDate && `Recon ${dateForLabel(record.reconstitutedDate)}`,
    record.storage && `Store ${record.storage}`,
  ].filter(Boolean).join('  |  ');
  if (preparedAndStorage) lines.push(preparedAndStorage);
  if (record.notes) lines.push(`Note ${record.notes}`);
  return lines.slice(0, 6);
}

function renderBand(record, start, pitch, { landscape, printWidthDots, labelLengthDots }) {
  let zpl = '';
  const details = bandLines(record);
  const nameHeight = 48;
  const nameWidth = 34;
  const detailHeight = 34;
  const detailWidth = 22;
  const rowGap = 2;
  const detailStep = detailHeight + rowGap;
  const bandContentEnd = details.length
    ? nameHeight + rowGap + (details.length - 1) * detailStep + detailHeight
    : nameHeight;
  const contentStart = Math.max(4, Math.floor((pitch - bandContentEnd) / 2));
  const blockWidth = Math.max(1, labelLengthDots - 28);

  if (landscape) {
    // ^A0R rotates the text clockwise. Assign the portrait design's last
    // vertical slot to the first row so the physical top-to-bottom order stays
    // Name, then the details, on landscape media.
    const nameX = details.length
      ? start + contentStart + nameHeight + rowGap + (details.length - 1) * detailStep
      : start + contentStart;
    zpl += textField(nameX, 12, record.name, {
      height: nameHeight, width: nameWidth, orientation: 'R', blockWidth,
    });
    details.forEach((line, index) => {
      const x = start + contentStart + (details.length - 1 - index) * detailStep;
      zpl += textField(x, 12, line, {
        height: detailHeight, width: detailWidth, orientation: 'R', blockWidth,
      });
    });
  } else {
    const textWidth = Math.max(1, printWidthDots - 20);
    zpl += textField(10, start + contentStart, record.name, {
      height: nameHeight, width: nameWidth, blockWidth: textWidth,
    });
    details.forEach((line, index) => {
      const y = start + contentStart + nameHeight + rowGap + index * detailStep;
      zpl += textField(10, y, line, {
        height: detailHeight, width: detailWidth, blockWidth: textWidth,
      });
    });
  }
  return zpl;
}

function buildPrintPayload(record, quantity, labelsPerStock, printer) {
  const printWidthDots = printer.printWidthDots;
  const labelLengthDots = printer.labelLengthDots;
  const landscape = printWidthDots >= labelLengthDots;
  const longAxisDots = Math.max(printWidthDots, labelLengthDots);
  const pitch = longAxisDots / labelsPerStock;
  const stockCount = Math.ceil(quantity / labelsPerStock);
  const formats = [];
  let remaining = quantity;
  for (let sheet = 0; sheet < stockCount; sheet += 1) {
    const activeBands = Math.min(labelsPerStock, remaining);
    let zpl = `^XA\n^CI28\n^PW${printWidthDots}\n^LL${labelLengthDots}\n^LH0,0\n^PR3\n`;
    for (let slot = 0; slot < activeBands; slot += 1) {
      const start = Math.round(slot * pitch);
      zpl += renderBand(record, start, pitch, { landscape, printWidthDots, labelLengthDots });
      const edge = Math.round((slot + 1) * pitch) - 2;
      zpl += landscape
        ? `^FO${edge},0^GB1,${labelLengthDots},1,B^FS\n`
        : `^FO0,${edge}^GB${printWidthDots},1,1,B^FS\n`;
    }
    zpl += '^PQ1\n^XZ\n';
    formats.push(zpl);
    remaining -= activeBands;
  }
  return { payload: Buffer.from(formats.join(''), 'ascii'), stockCount };
}

function sendToPrinter(payload, host = selectedPrinterHost) {
  if (!host) return Promise.reject(new Error('No printer is selected.'));
  return new Promise((resolveSend, rejectSend) => {
    let settled = false;
    const socket = createConnection({ host, port: PRINTER_PORT, timeout: 5000 });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      rejectSend(error);
    };
    socket.once('connect', () => {
      socket.end(payload, () => {
        if (settled) return;
        settled = true;
        resolveSend();
      });
    });
    socket.once('timeout', () => fail(new Error('Printer connection timed out.')));
    socket.once('error', fail);
  });
}

function insertJob(record, quantity, stockCount, labelsPerStock, status, error = '') {
  const result = db.prepare(`
    INSERT INTO print_jobs
      (peptide_id, peptide_name, quantity, stock_labels, labels_per_stock, status, error, snapshot_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    record.id,
    record.name,
    quantity,
    stockCount,
    labelsPerStock,
    status,
    error,
    JSON.stringify(record),
    now(),
  );
  return Number(result.lastInsertRowid);
}

function updateJob(id, status, error = '') {
  db.prepare('UPDATE print_jobs SET status = ?, error = ? WHERE id = ?').run(status, error, id);
}

async function handleApi(req, res, url) {
  if (req.method !== 'GET') checkBrowserOrigin(req);

  if (url.pathname === '/api/peptides' && req.method === 'GET') {
    return sendJson(res, 200, { records: listRecords.all().map(rowToRecord) });
  }
  if (url.pathname === '/api/jobs' && req.method === 'GET') {
    return sendJson(res, 200, { jobs: listJobs.all() });
  }
  if (url.pathname === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, { printer: await getPrinterStatus(selectedPrinterHost) });
  }
  if (url.pathname === '/api/printers/discover' && req.method === 'POST') {
    return sendJson(res, 200, await discoverPrinters());
  }
  if (url.pathname === '/api/printer/select' && req.method === 'POST') {
    const request = await readJson(req);
    const host = String(request.host || '').trim();
    if (!isPrivateIpv4(host)) throw new HttpError(400, 'Choose a printer found on the private local network.');
    if (!lastDiscoveredHosts.has(host)) throw new HttpError(400, 'Find printers on the network before selecting one.');
    const printer = await getPrinterStatus(host);
    if (!printer.connected || !printer.zebraIdentified) {
      throw new HttpError(409, 'That Zebra printer could not be verified. Run network discovery and select a detected device.');
    }
    selectedPrinterHost = host;
    putSetting.run('printer_host', host, now());
    return sendJson(res, 200, { selectedHost: selectedPrinterHost, printer });
  }
  if (url.pathname === '/api/backup' && req.method === 'GET') {
    const records = listRecords.all().map(rowToRecord);
    const jobs = db.prepare(`SELECT * FROM print_jobs ORDER BY id DESC`).all();
    const backup = Buffer.from(JSON.stringify({ exportedAt: now(), records, printJobs: jobs }, null, 2));
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': 'attachment; filename="vial-label-studio-backup.json"',
      'content-length': backup.length,
      'cache-control': 'no-store',
    });
    return res.end(backup);
  }
  if (url.pathname === '/api/peptides' && req.method === 'POST') {
    const record = normalizeRecord(await readJson(req));
    const timestamp = now();
    const keys = Object.keys(DB_COLUMN);
    const sqlCols = keys.map((key) => DB_COLUMN[key]);
    const placeholders = keys.map(() => '?').join(',');
    const values = keys.map((key) => record[key]);
    const result = db.prepare(`INSERT INTO peptides (${sqlCols.join(',')}, created_at, updated_at) VALUES (${placeholders}, ?, ?)`)
      .run(...values, timestamp, timestamp);
    return sendJson(res, 201, { record: rowToRecord(getRecord.get(Number(result.lastInsertRowid))) });
  }

  const recordMatch = url.pathname.match(/^\/api\/peptides\/(\d+)$/);
  if (recordMatch && req.method === 'PUT') {
    const id = Number(recordMatch[1]);
    if (!getRecord.get(id)) throw new HttpError(404, 'That peptide record was not found.');
    const record = normalizeRecord(await readJson(req));
    const keys = Object.keys(DB_COLUMN);
    const assignments = keys.map((key) => `${DB_COLUMN[key]} = ?`).join(', ');
    db.prepare(`UPDATE peptides SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...keys.map((key) => record[key]), now(), id);
    return sendJson(res, 200, { record: rowToRecord(getRecord.get(id)) });
  }
  if (recordMatch && req.method === 'DELETE') {
    const id = Number(recordMatch[1]);
    if (!getRecord.get(id)) throw new HttpError(404, 'That peptide record was not found.');
    db.prepare('DELETE FROM peptides WHERE id = ?').run(id);
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === '/api/print' && req.method === 'POST') {
    const request = await readJson(req);
    const id = Number(request.recordId);
    const quantity = Number(request.quantity);
    const labelsPerStock = Number(request.labelsPerStock);
    if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'Select a saved record to print.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PRINT_QUANTITY) {
      throw new HttpError(400, `Label quantity must be from 1 to ${MAX_PRINT_QUANTITY}.`);
    }
    if (!VALID_UPS.has(labelsPerStock)) throw new HttpError(400, 'Choose 3 or 4 strips per 2×4 portrait design.');
    if (request.mediaConfirmed !== true) throw new HttpError(400, 'Confirm that the roll is loaded in the orientation shown by the printer report and calibrated.');
    const record = rowToRecord(getRecord.get(id));
    if (!record) throw new HttpError(404, 'That peptide record was not found.');

    const status = await getPrinterStatus(selectedPrinterHost);
    if (!status.connected || !status.ready) {
      throw new HttpError(503, status.error || 'The printer is not reporting READY; no label job was sent.');
    }
    if (!status.mediaReady) {
      throw new HttpError(409, 'Printer media dimensions were not readable. Refresh printer status before printing.');
    }

    const { payload, stockCount } = buildPrintPayload(record, quantity, labelsPerStock, status);
    const jobId = insertJob(record, quantity, stockCount, labelsPerStock, 'sending');
    try {
      await sendToPrinter(payload, status.host);
      updateJob(jobId, 'submitted', '');
    } catch (error) {
      updateJob(jobId, 'outcome-uncertain', error.message);
      throw new HttpError(502, `The printer connection ended before confirmation. Job ${jobId} was not retried; check the printer before sending it again.`);
    }
    const job = db.prepare(`
      SELECT id, peptide_name AS peptideName, quantity, stock_labels AS stockLabels,
        labels_per_stock AS labelsPerStock, status, created_at AS createdAt
      FROM print_jobs WHERE id = ?
    `).get(jobId);
    return sendJson(res, 200, { job, printer: status, message: `${quantity} cut strip${quantity === 1 ? '' : 's'} submitted across ${stockCount} printer label${stockCount === 1 ? '' : 's'}.` });
  }
  throw new HttpError(404, 'Not found.');
}

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml; charset=utf-8']],
]);

function sendStatic(res, pathname) {
  const found = STATIC_FILES.get(pathname);
  if (!found) throw new HttpError(404, 'Not found.');
  const [file, contentType] = found;
  const absolute = resolve(PUBLIC_DIR, file);
  const content = readFileSync(absolute);
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': content.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(content);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else if (req.method === 'GET') {
      sendStatic(res, url.pathname);
    } else {
      throw new HttpError(405, 'Method not allowed.');
    }
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Vial Label Studio is running at ${url}`);
  console.log(`Printer target: ${selectedPrinterHost ? `${selectedPrinterHost}:${PRINTER_PORT}` : `not selected (raw ZPL port ${PRINTER_PORT})`}`);
  console.log(`SQLite database: ${DB_PATH}`);
  const openBrowser = process.env.OPEN_BROWSER !== '0' && !process.argv.includes('--no-open');
  if (openBrowser && process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) {
    const opener = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    opener.unref();
  }
});

function stop() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

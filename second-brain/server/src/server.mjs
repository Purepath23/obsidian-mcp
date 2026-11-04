import http from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scanVault, saveIdea, saveManaged } from './vault.mjs';
import { syncVault } from './sync.mjs';
import { generateDaily, readDaily, saveDaily } from './recommend.mjs';

const port = Number(process.env.PORT || 8080);
const dataDir = resolve(process.env.DATA_DIR || './data');
const vaultDir = resolve(process.env.VAULT_DIR || `${dataDir}/vault`);
const token = process.env.SECOND_BRAIN_TOKEN || '';
const apiKey = process.env.OPENAI_API_KEY || '';
const maxMonthlyUsd = Number(process.env.MAX_MONTHLY_USD || 4);
const externalSync = process.env.SYNC_EXTERNAL === '1';
if (!token || token.length < 32) throw new Error('SECOND_BRAIN_TOKEN deve contenere almeno 32 caratteri casuali.');
if (!Number.isFinite(maxMonthlyUsd) || maxMonthlyUsd <= 0) throw new Error('MAX_MONTHLY_USD non valido.');
await mkdir(vaultDir, { recursive: true });
await mkdir(dataDir, { recursive: true });

let lastVaultCheck = null;
let syncError = 'Copia del vault non ancora verificata.';
let currentSync = null;
let currentDaily = null;

function authorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer /, '') || '';
  const a = Buffer.from(supplied), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(value));
}

async function body(request, limit = 10000) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > limit) throw new Error('Richiesta troppo grande.');
  }
  return JSON.parse(raw || '{}');
}

async function sync() {
  if (currentSync) return currentSync;
  const run = externalSync ? async () => {
    // The existing Obsidian Headless process owns the continuous sync lock.
    await stat(`${vaultDir}/.railway-vault-configured`);
  } : () => syncVault(vaultDir);
  currentSync = run().then(() => {
    lastVaultCheck = new Date().toISOString(); syncError = null;
  }).catch(error => {
    syncError = error.message.slice(0, 200); throw error;
  }).finally(() => { currentSync = null; });
  return currentSync;
}

function todayRome() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function daily({ force = false } = {}) {
  if (currentDaily) return currentDaily;
  currentDaily = (async () => {
    await sync();
    const bundle = await scanVault(vaultDir);
    const revision = createHash('sha256').update(bundle.files.map(file => `${file.path}:${file.hash}`).sort().join('\n')).digest('hex');
    const old = await readDaily(dataDir);
    if (!force && old?.day === todayRome() && old?.source_revision === revision && old?.ai_configured === !!apiKey) return old;
    const result = { ...await generateDaily(bundle, { dataDir, apiKey, maxMonthlyUsd }),
      source_revision: revision, ai_configured: !!apiKey };
    await saveDaily(dataDir, result);
    return result;
  })().finally(() => { currentDaily = null; });
  return currentDaily;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/health' && request.method === 'GET') {
      json(response, 200, { ok: true, vaultReady: !!lastVaultCheck, vaultError: syncError ? 'Copia del vault non pronta' : null }); return;
    }
    if (!authorized(request)) { json(response, 401, { error: 'Non autorizzato.' }); return; }
    if (url.pathname === '/v1/status' && request.method === 'GET') {
      json(response, 200, { lastVaultCheck, vaultError: syncError, aiConfigured: !!apiKey, today: todayRome() }); return;
    }
    if (url.pathname === '/v1/snapshot' && request.method === 'GET') {
      if (!lastVaultCheck || Date.now() - Date.parse(lastVaultCheck) > 5 * 60 * 1000) await sync();
      json(response, 200, await scanVault(vaultDir)); return;
    }
    if (url.pathname === '/v1/daily' && request.method === 'GET') {
      json(response, 200, await daily()); return;
    }
    if (url.pathname === '/v1/daily/refresh' && request.method === 'POST') {
      json(response, 200, await daily({ force: true })); return;
    }
    if (url.pathname === '/v1/ideas' && request.method === 'POST') {
      const input = await body(request);
      await sync();
      const saved = await saveIdea(vaultDir, input.id, input.text);
      if (externalSync) { json(response, 202, { ...saved, synced: false, message: 'Idea salvata sul servizio; Obsidian Headless la sincronizzerà.' }); return; }
      try { await sync(); json(response, 201, { ...saved, synced: true }); }
      catch { json(response, 202, { ...saved, synced: false, message: 'Idea salvata sul servizio; invio a Obsidian Sync in attesa.' }); }
      return;
    }
    if (url.pathname === '/v1/persist' && request.method === 'POST') {
      const input = await body(request, 1024 * 1024);
      await sync();
      const saved = await saveManaged(vaultDir, input.writes);
      if (externalSync) { json(response, 202, { ...saved, synced: false, message: 'Note salvate sul servizio; Obsidian Headless le sincronizzerà.' }); return; }
      try { await sync(); json(response, 200, { ...saved, synced: true }); }
      catch { json(response, 202, { ...saved, synced: false, message: 'Note salvate sul servizio; invio a Obsidian Sync in attesa.' }); }
      return;
    }
    json(response, 404, { error: 'Percorso non disponibile.' });
  } catch (error) {
    // Never log note contents, prompts, credentials, or request bodies.
    json(response, 503, { error: error.message.slice(0, 200) });
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Second Brain service ready on ${server.address().port}`));
setInterval(async () => {
  try { await sync(); await daily(); }
  catch (error) { console.error(`Background cycle failed: ${error.message.slice(0, 120)}`); }
}, 5 * 60 * 1000).unref();
sync().then(() => daily()).catch(error => console.error(`Initial sync failed: ${error.message.slice(0, 120)}`));

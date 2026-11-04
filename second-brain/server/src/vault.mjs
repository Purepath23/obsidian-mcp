import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, stat, lstat, mkdir, writeFile, link, unlink, rename } from 'node:fs/promises';
import path from 'node:path';

const EXCLUDE = new Set(['.obsidian', '.trash', '.git', 'Backup', 'Backups', 'node_modules', 'lost+found']);
const JSON_NAMES = new Set(['azioni.json', 'scadenze.json', 'progetti.json', 'fonti.json']);
const MAX_FILES = 10000;
const MAX_TOTAL = 96 * 1024 * 1024;
const MAX_FILE = 12 * 1024 * 1024;

async function managedDir(root, leaf) {
  let dir = root;
  for (const name of ['SecondBrain', leaf]) {
    dir = path.join(dir, name);
    try { await mkdir(dir); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!(await lstat(dir)).isDirectory()) throw new Error('Cartella gestita non valida.');
  }
  return dir;
}

export async function scanVault(root) {
  const files = [];
  let total = 0, bytes = 0;
  async function walk(dir, rel, depth) {
    if (depth > 40) throw new Error('Vault troppo profondo.');
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (EXCLUDE.has(entry.name) || entry.name.startsWith('.')) continue;
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full, name, depth + 1); continue; }
      if (!entry.isFile()) continue; // No symlinks outside the vault.
      if (!name.toLowerCase().endsWith('.md') && !JSON_NAMES.has(entry.name.toLowerCase())) continue;
      if (++total > MAX_FILES) throw new Error('Troppi file nel vault.');
      const info = await stat(full);
      if (info.size > MAX_FILE) throw new Error(`File troppo grande: ${name}`);
      const content = await readFile(full, 'utf8');
      if (content.includes('\ufffd')) throw new Error(`File non UTF-8: ${name}`);
      bytes += Buffer.byteLength(content);
      if (bytes > MAX_TOTAL) throw new Error('Vault troppo grande.');
      files.push({ path: name, content, mtime: info.mtime.toISOString(), hash: createHash('sha256').update(content).digest('hex') });
    }
  }
  await walk(root, '', 0);
  return { files };
}

export async function saveIdea(root, id, text, now = new Date()) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Identificativo idea non valido.');
  const body = String(text ?? '').trim();
  if (!body || body.length > 8000) throw new Error('L’idea deve avere da 1 a 8000 caratteri.');
  const dir = await managedDir(root, 'Idee');
  const file = path.join(dir, `${id}.md`);
  try { await stat(file); return { path: `SecondBrain/Idee/${id}.md`, created: false }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const title = body.split(/\r?\n/, 1)[0].replace(/^#+\s*/, '').slice(0, 100) || 'Idea';
  const content = `---\ncreated: ${now.toISOString()}\nkind: idea\nsource: second-brain\n---\n\n# ${title}\n\n${body}\n`;
  const part = path.join(dir, `.${id}.${randomUUID()}.part`);
  await writeFile(part, content, { flag: 'wx', mode: 0o600 });
  try {
    await link(part, file); // Fails rather than replacing an existing idea from a retry.
    return { path: `SecondBrain/Idee/${id}.md`, created: true };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { path: `SecondBrain/Idee/${id}.md`, created: false };
  } finally { await unlink(part); }
}

export async function saveManaged(root, writes, now = new Date()) {
  if (!Array.isArray(writes) || writes.length > 20) throw new Error('Numero di note non valido.');
  await managedDir(root, 'Elementi');
  const backupBase = await managedDir(root, 'Backup');
  const planned = [];
  const seen = new Set();
  for (const write of writes) {
    const rel = write?.path;
    if (typeof rel !== 'string' || !/^SecondBrain\/Elementi\/[A-Za-z0-9_-]{1,160}\.md$/.test(rel) || seen.has(rel))
      throw new Error('Percorso di nota non gestito o duplicato.');
    seen.add(rel);
    const bytes = Buffer.from(String(write.content ?? ''), 'utf8');
    if (!bytes.length || bytes.length > MAX_FILE) throw new Error('Dimensione nota non valida.');
    const target = path.join(root, rel);
    let previous = null;
    try {
      const info = await lstat(target);
      if (!info.isFile()) throw new Error('Il percorso della nota non è un file regolare.');
      previous = await readFile(target);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const actual = previous === null ? null : createHash('sha256').update(previous).digest('hex');
    const expected = write.expectedHash ?? null;
    if (actual !== expected) throw new Error(`Conflitto: ${rel} è cambiata nel vault. Rileggi prima di salvare.`);
    planned.push({ rel, target, bytes, previous, expected });
  }
  if (!planned.length) return { hashes: {} };
  const backup = path.join(backupBase, `${now.toISOString().replaceAll(':', '-')}_${randomUUID()}`);
  await mkdir(backup);
  const journal = [];
  for (const item of planned) {
    if (item.previous !== null) await writeFile(path.join(backup, path.basename(item.rel)), item.previous, { flag: 'wx', mode: 0o600 });
    journal.push({ path: item.rel, previousHash: item.expected,
      newHash: createHash('sha256').update(item.bytes).digest('hex') });
  }
  await writeFile(path.join(backup, 'registro.json'), JSON.stringify({ writes: journal }, null, 2), { flag: 'wx', mode: 0o600 });
  const hashes = {};
  const committed = [];
  try {
    for (const item of planned) {
      let current = null;
      try { current = await readFile(item.target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const currentHash = current === null ? null : createHash('sha256').update(current).digest('hex');
      if (currentHash !== item.expected) throw new Error(`Conflitto durante il salvataggio: ${item.rel}`);
      const part = `${item.target}.${randomUUID()}.part`;
      await writeFile(part, item.bytes, { flag: 'wx', mode: 0o600 });
      await rename(part, item.target);
      hashes[item.rel] = journal.find(entry => entry.path === item.rel).newHash;
      committed.push(item.rel);
    }
  } catch (error) {
    throw new Error(`${error.message} Note già scritte: ${committed.join(', ') || 'nessuna'}. Backup: ${path.relative(root, backup)}.`);
  }
  return { hashes, backup: path.relative(root, backup) };
}

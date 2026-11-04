import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { scanVault, saveIdea, saveManaged } from '../src/vault.mjs';
import { generateDaily, selectContext, validateSuggestions } from '../src/recommend.mjs';

test('vault scan excludes settings and symlinks; idea saves once by ID', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'second-brain-vault-'));
  await mkdir(path.join(root, '.obsidian'));
  await writeFile(path.join(root, '.obsidian', 'sync.json'), 'secret');
  await writeFile(path.join(root, 'Progetto.md'), '# Progetto\nScadenza 2026-11-05');
  await symlink('/etc/passwd', path.join(root, 'outside.md'));
  const bundle = await scanVault(root);
  assert.deepEqual(bundle.files.map(file => file.path), ['Progetto.md']);
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal((await saveIdea(root, id, 'Una nuova idea')).created, true);
  assert.equal((await saveIdea(root, id, 'Testo diverso')).created, false);
  assert.match(await readFile(path.join(root, 'SecondBrain/Idee', `${id}.md`), 'utf8'), /Una nuova idea/);
});

test('managed note checks its hash, saves a preimage, and rejects linked directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'second-brain-managed-'));
  const rel = 'SecondBrain/Elementi/prova.md';
  const first = await saveManaged(root, [{ path: rel, content: '# Prima', expectedHash: null }]);
  assert.equal(first.hashes[rel], createHash('sha256').update('# Prima').digest('hex'));
  await assert.rejects(saveManaged(root, [{ path: rel, content: '# Persa', expectedHash: null }]), /Conflitto/);
  const second = await saveManaged(root, [{ path: rel, content: '# Seconda', expectedHash: first.hashes[rel] }]);
  assert.equal(await readFile(path.join(root, rel), 'utf8'), '# Seconda');
  assert.equal(await readFile(path.join(root, second.backup, 'prova.md'), 'utf8'), '# Prima');
  const linkedRoot = await mkdtemp(path.join(os.tmpdir(), 'second-brain-linked-'));
  await symlink(path.join(root, 'SecondBrain'), path.join(linkedRoot, 'SecondBrain'));
  await assert.rejects(saveIdea(linkedRoot, '22222222-2222-4222-8222-222222222222', 'Non uscire'), /Cartella gestita/);
});

test('AI gets excerpts, cannot cite unknown files or invent an unsupported date', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'second-brain-ai-'));
  const bundle = { files: [{ path: 'Idee/progetto.md', content: '# Progetto\nControllare la proposta entro 2026-11-05.\npassword: riservata', mtime: '2026-11-04T09:00:00Z', hash: 'a' }] };
  const sources = selectContext(bundle, new Date('2026-11-04T10:00:00Z')).sources;
  assert.deepEqual(validateSuggestions({ suggestions: [
    { title: 'Controlla la proposta', reason: 'È annotata una verifica.', source_path: 'Idee/progetto.md', date: '2026-11-05', kind: 'progetto' },
    { title: 'Paga', reason: 'Inventata.', source_path: 'altro.md', date: null, kind: 'scadenza' },
    { title: 'Data inventata', reason: 'Non nel testo.', source_path: 'Idee/progetto.md', date: '2026-12-01', kind: 'progetto' },
  ] }, sources).map(value => value.date), ['2026-11-05', null]);
  let payload;
  const result = await generateDaily(bundle, { dataDir, apiKey: 'test', now: new Date('2026-11-04T10:00:00Z'), fetchImpl: async (_url, init) => {
    payload = JSON.parse(init.body);
    return { ok: true, json: async () => ({ usage: { input_tokens: 100, output_tokens: 50 }, output: [{ content: [{ type: 'output_text', text: JSON.stringify({ suggestions: [
      { title: 'Controlla la proposta', reason: 'Verifica il progetto.', source_path: 'Idee/progetto.md', date: '2026-11-05', kind: 'progetto' },
    ] }) }] }] }) };
  } });
  assert.equal(payload.store, false);
  assert.ok(payload.input.includes('Controllare la proposta'));
  assert.ok(!payload.input.includes('riservata'));
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].source_path, 'Idee/progetto.md');
  const limited = await generateDaily(bundle, { dataDir, apiKey: 'test', maxMonthlyUsd: 0.000001 });
  assert.equal(limited.mode, 'limite_ai');
});

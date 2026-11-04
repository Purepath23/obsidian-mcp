/** Offline, evidence-preserving Second Brain engine. No network or platform APIs. */
export const TIMEZONE = 'Europe/Rome';
const VERSION = 1;
const CLOSED = new Set(['completato', 'annullato']);
const STATUSES = new Set(['aperto', 'in_attesa', 'da_verificare', 'bloccato', 'completato', 'annullato', 'rinviato']);
const EVIDENCE = new Set(['confermato', 'storico', 'ipotesi', 'da_verificare']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const clone = value => JSON.parse(JSON.stringify(value));
const stamp = value => value ? validInstant(value) : new Date().toISOString();
const leaf = path => path.split('/').pop();
const folder = path => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const joined = (base, name) => base ? base + '/' + name : name;
const flat = text => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
}
function portable(item) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !key.startsWith('_')));
}
function fingerprint(item) { return stable(portable(item)); }
function validPath(path) {
  if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.' || p === '')) throw new Error('Percorso del vault non valido.');
  return path;
}
function safeId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)) throw new Error('Identificativo non valido.');
  return value;
}
function validDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error('Data non valida: usare AAAA-MM-GG.');
  const day = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value) throw new Error('Il giorno indicato non esiste.');
  return value;
}
export function validInstant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value)) throw new Error('Data e ora richiedono il fuso esplicito (+01:00 o +02:00).');
  validDate(value.slice(0, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = value.slice(16, 19).startsWith(':') ? Number(value.slice(17, 19)) : 0;
  if (hour > 23 || minute > 59 || second > 59 || !Number.isFinite(Date.parse(value))) throw new Error('Ora non valida.');
  if (/[+-]\d{2}:\d{2}$/.test(value)) {
    const offsetHour = Number(value.slice(-5, -3)), offsetMinute = Number(value.slice(-2));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute)) throw new Error('Offset del fuso non valido.');
  }
  return value;
}
function parts(instant) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('Data non valida.');
  const entries = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Object.fromEntries(entries.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
export function romeDate(instant = new Date().toISOString()) {
  const p = parts(instant); return `${p.year}-${p.month}-${p.day}`;
}
/** Rejects DST gaps and overlaps unless the caller explicitly selects a fold. */
export function romeLocalToISO(value, disambiguation) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error('Data e ora locale non valide.');
  validDate(value.slice(0, 10));
  const local = value.length === 16 ? value + ':00' : value;
  if (Number(local.slice(11, 13)) > 23 || Number(local.slice(14, 16)) > 59 || Number(local.slice(17, 19)) > 59) throw new Error('Ora non valida.');
  const utc = Date.parse(local + 'Z');
  const matches = [];
  for (let offset = -180; offset <= 180; offset += 15) {
    const candidate = utc - offset * 60000;
    const p = parts(candidate);
    if (`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}` === local) {
      const sign = offset < 0 ? '-' : '+';
      const abs = Math.abs(offset);
      matches.push({ epoch: candidate, iso: local + sign + String(Math.floor(abs / 60)).padStart(2, '0') + ':' + String(abs % 60).padStart(2, '0') });
    }
  }
  matches.sort((a, b) => a.epoch - b.epoch);
  if (!matches.length) throw new Error('Questa ora non esiste a Roma per il passaggio all’ora legale. Scegli un’altra ora.');
  if (matches.length > 1 && !['earlier', 'later'].includes(disambiguation)) throw new Error('Questa ora si ripete a Roma nel cambio dell’ora. Scegli un’ora diversa o specifica prima/dopo il cambio.');
  return matches[disambiguation === 'later' ? matches.length - 1 : 0].iso;
}
function dueValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return DATE.test(value) ? validDate(value) : validInstant(value);
}
function dueDay(item) { return item.due ? (DATE.test(item.due) ? item.due : romeDate(item.due)) : null; }
function noteBase(path) { return path.replace(/(?:^|\/)dati\/[^/]+$/, ''); }
function normalized(item, { imported = false, now = null, sourcePath = null } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Elemento non valido.');
  safeId(item.id);
  if (typeof item.title !== 'string' || !item.title.trim()) throw new Error('Il titolo è obbligatorio.');
  if (!STATUSES.has(item.status ?? 'aperto')) throw new Error('Stato dell’attività non valido.');
  if (item.evidence && !EVIDENCE.has(item.evidence)) throw new Error('Qualifica dell’informazione non valida.');
  if (item.amount != null && (typeof item.amount !== 'number' || !Number.isFinite(item.amount) || item.amount < 0)) throw new Error('Importo non valido.');
  const out = {
    ...item, title: item.title.trim(), status: item.status ?? 'aperto',
    kind: item.kind ?? 'attivita', area: item.area ?? 'personale',
    as_of: item.as_of ?? (now ? romeDate(now) : null), due: dueValue(item.due),
    due_precision: item.due_precision ?? (item.due ? (DATE.test(item.due) ? 'giorno' : 'ora') : 'non_nota'),
    due_kind: item.due_kind ?? (imported ? 'non_nota' : 'confermata_utente'),
    timezone: TIMEZONE, amount: item.amount ?? null, currency: item.currency ?? null,
    relative_due: item.relative_due ?? null, sources: Array.isArray(item.sources) ? [...new Set(item.sources.filter(s => typeof s === 'string'))] : [],
    note: typeof item.note === 'string' ? item.note : null, details: String(item.details ?? ''),
    updated_at: item.updated_at ?? item.as_of ?? now,
    evidence: item.evidence ?? (item.status === 'completato' ? 'storico' : 'da_verificare'),
    reminder: imported ? null : item.reminder ?? null, history: Array.isArray(item.history) ? clone(item.history) : [],
  };
  if (out.reminder) {
    if (typeof out.reminder !== 'object' || Array.isArray(out.reminder)) throw new Error('Promemoria non valido.');
    if (out.reminder.enabled) validInstant(out.reminder.at);
  }
  if (CLOSED.has(out.status)) out.reminder = null;
  if (sourcePath) {
    out._source_path = sourcePath;
    out._note_path = out.note ? joined(noteBase(sourcePath), out.note) : sourcePath;
  }
  return out;
}
export function createState() {
  return { schema_version: VERSION, timezone: TIMEZONE, items: [], projects: [], sources: [], documents: [], settings: { dailyDigest: '08:00', digestEnabled: false, hideSensitive: true }, conflicts: [], tombstones: [], resolutions: [], importedAt: null };
}
function addConflict(state, type, id, message, incoming = null) {
  if (state.resolutions?.some(r => r.type === type && r.id === id && r.incoming_fingerprint === stable(incoming))) return;
  const existing = state.conflicts.find(c => c.type === type && c.id === id && stable(c.incoming) === stable(incoming));
  if (!existing) state.conflicts.push({ type, id, message, incoming, detected_at: state.importedAt });
}
function rawFrontmatter(text) {
  if (!/^---\r?\n/.test(text)) return {};
  const end = text.slice(4).search(/\r?\n---(?:\r?\n|$)/);
  if (end < 0) return {};
  const head = text.slice(4, end + 4), out = {};
  for (const line of head.split(/\r?\n/)) {
    const match = /^([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    try { out[match[1]] = JSON.parse(match[2]); }
    catch { out[match[1]] = match[2].replace(/^['"]|['"]$/g, ''); }
  }
  return out;
}
export function parseManaged(text) {
  if (typeof text !== 'string' || !/^---\r?\n/.test(text)) return null;
  const head = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!head) return null;
  const match = head.match(/^second_brain:\s*(\{[^\r\n]*\})\s*$/m);
  if (!match) return null;
  let item;
  try { item = JSON.parse(match[1]); }
  catch { throw new Error('Metadati Second Brain danneggiati: correggere o ripristinare la nota.'); }
  const parsed = normalized(item);
  const marker = '<!-- second-brain:details -->';
  const body = text.slice(text.indexOf(head) + head.length).replace(/^\r?\n---\r?\n?/, '').replace(/^\n/, '');
  const position = body.indexOf(marker);
  if (position >= 0) {
    const actualPrefix = body.slice(0, position).trimEnd();
    const expectedPrefix = managedPrelude(parsed).trimEnd();
    if (actualPrefix !== expectedPrefix) {
      parsed.preserved_body = [...new Set([...(Array.isArray(parsed.preserved_body) ? parsed.preserved_body : []), actualPrefix])];
      parsed._body_edited = true;
    }
    const details = body.slice(position + marker.length).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    if (details !== parsed.details) parsed._body_edited = true;
    parsed.details = details;
  } else {
    // Legacy canonical notes had no editable-details marker. Keep their entire
    // body if it differs from the legacy generated view, rather than losing it.
    const expectedLegacy = legacyBody(parsed).trim();
    if (body.trim() !== expectedLegacy) {
      parsed.preserved_body = [...new Set([...(Array.isArray(parsed.preserved_body) ? parsed.preserved_body : []), body.trim()])];
      parsed._body_edited = true;
    }
  }
  return parsed;
}
function legacyBody(clean) {
  const line = value => String(value ?? '').replace(/[\r\n]/g, ' ');
  const amount = clean.amount == null ? '' : `\n- Importo citato: ${clean.amount} ${clean.currency ?? ''}`;
  return `# ${line(clean.title)}\n\n- ID: ${clean.id}\n- Stato: ${clean.status}\n- Qualifica: ${clean.evidence}\n- Area: ${line(clean.area)}\n- Data della fonte: ${line(clean.as_of) || 'non indicata'}\n- Ultimo aggiornamento: ${line(clean.updated_at) || 'non indicato'}\n- Scadenza: ${line(clean.due) || 'non definita'}${amount}\n- Fonti: ${clean.sources.map(line).join(', ') || 'inserimento personale'}\n\n${clean.details}\n\n> I metadati nella proprietà second_brain sono l’elemento strutturato canonico. Modificare anche quella proprietà per cambiare stato, data o avviso; il corpo è una rappresentazione leggibile.\n`;
}
function managedPrelude(clean) {
  const line = value => String(value ?? '').replace(/[\r\n]/g, ' ');
  const amount = clean.amount == null ? '' : `\n- Importo citato: ${clean.amount} ${clean.currency ?? ''}`;
  const preserved = Array.isArray(clean.preserved_body) && clean.preserved_body.length ? '\n\n## Testo precedente conservato da Obsidian\n\n' + clean.preserved_body.join('\n\n---\n\n') : '';
  return `# ${line(clean.title)}\n\n- ID: ${clean.id}\n- Stato: ${clean.status}\n- Qualifica: ${clean.evidence}\n- Area: ${line(clean.area)}\n- Data della fonte: ${line(clean.as_of) || 'non indicata'}\n- Ultimo aggiornamento: ${line(clean.updated_at) || 'non indicato'}\n- Scadenza: ${line(clean.due) || 'non definita'}${amount}\n- Fonti: ${clean.sources.map(line).join(', ') || 'inserimento personale'}\n\n> Stato, data e avvisi si cambiano nella proprietà second_brain. I dettagli sotto il marcatore sono modificabili liberamente in Obsidian.${preserved}\n\n## Dettagli\n\n`;
}
export function managedMarkdown(item) {
  const clean = portable(normalized(item));
  return `---\nsecond_brain: ${JSON.stringify(clean)}\n---\n\n${managedPrelude(clean)}<!-- second-brain:details -->\n${clean.details}\n`;
}
function documentFrom(file) {
  const fm = file.frontmatter ?? rawFrontmatter(file.content);
  const title = fm.title || file.content.match(/^#\s+(.+)$/m)?.[1] || leaf(file.path).replace(/\.md$/i, '');
  const sourceDate = fm.updated || fm.as_of || fm.created || null;
  return { id: file.path, path: file.path, title: String(title), text: file.content, date: sourceDate ? String(sourceDate).slice(0, 10) : null, mtime: file.mtime ?? null, hash: file.hash ?? null, sensitivity: fm.sensitivity ?? 'privata', sources: Array.isArray(fm.sources) ? fm.sources : [], type: 'document' };
}
function mergeAux(state, target, incoming, sourcePath) {
  const map = new Map(state[target].map(v => [v.id, v]));
  for (const value of incoming) {
    if (!value || typeof value.id !== 'string') throw new Error(`Record ${target} senza identificativo.`);
    safeId(value.id);
    const old = map.get(value.id), candidate = { ...clone(value), _source_path: sourcePath };
    if (!old || stable(portable(old)) === stable(portable(candidate))) map.set(value.id, candidate);
    else if (old._source_path === sourcePath) map.set(value.id, candidate);
    else addConflict(state, target + '_id', value.id, 'Stesso identificativo con dati diversi: conservata la versione già indicizzata.', candidate);
  }
  state[target] = [...map.values()];
}
/** A bundle is a full vault scan, not a partial incremental feed. */
export function importBundle(state, bundle, nowIso) {
  if (!bundle || !Array.isArray(bundle.files)) throw new Error('La scansione non contiene un elenco di file.');
  const next = clone(state ?? createState());
  next.importedAt = stamp(nowIso); next.conflicts ??= []; next.tombstones ??= [];
  next.projects = []; next.sources = [];
  const files = bundle.files.map(file => {
    validPath(file.path);
    if (typeof file.content !== 'string') throw new Error('Il contenuto della nota deve essere testo.');
    return file;
  }).filter(file => !file.path.split('/').some(p => p === '.obsidian' || p === '.trash' || p === '.git' || /^(?:backup|backups|SecondBrain_Backup)$/i.test(p)) && !file.path.startsWith('SecondBrain/Backup/'));
  next.documents = files.filter(f => /\.md$/i.test(f.path)).map(documentFrom);
  const byId = new Map(next.items.map(item => [item.id, item]));
  const originalInScan = new Map();
  const managedInScan = new Map();
  const actionFiles = files.filter(f => /(?:^|\/)azioni\.json$/.test(f.path));
  // scadenze.json is a view of azioni.json; it is never a second set of tasks.
  const imports = actionFiles.length ? actionFiles : files.filter(f => /(?:^|\/)scadenze\.json$/.test(f.path));
  for (const file of imports) {
    let data;
    try { data = JSON.parse(file.content); } catch { throw new Error(`JSON non valido: ${file.path}`); }
    if (!Array.isArray(data.items)) throw new Error(`Manca items in ${file.path}`);
    for (const raw of data.items) {
      const incoming = normalized(raw, { imported: true, sourcePath: file.path, now: next.importedAt });
      if (next.tombstones.some(t => t.id === incoming.id)) continue;
      const fp = fingerprint(incoming);
      const seen = originalInScan.get(incoming.id);
      if (seen && seen.fingerprint !== fp) {
        addConflict(next, 'duplicate_id', incoming.id, 'Due importazioni attribuiscono dati diversi allo stesso ID. Nessuna fusione automatica.', portable(incoming));
        continue;
      }
      originalInScan.set(incoming.id, { fingerprint: fp, incoming });
      const previous = byId.get(incoming.id);
      if (!previous) {
        incoming._source_fingerprint = fp; incoming._dirty = false; byId.set(incoming.id, incoming);
      } else if (previous._managed_path) {
        if (previous._source_fingerprint && previous._source_fingerprint !== fp) addConflict(next, 'original_changed', incoming.id, 'La fonte importata è cambiata; la nota personale è conservata.', portable(incoming));
      } else if (previous._dirty) {
        if (previous._source_fingerprint !== fp) addConflict(next, 'source_changed', incoming.id, 'La fonte è cambiata insieme a una modifica locale. La modifica locale è conservata.', portable(incoming));
      } else {
        incoming._source_fingerprint = fp; incoming._dirty = false; byId.set(incoming.id, incoming);
      }
    }
  }
  for (const file of files) {
    if (/(?:^|\/)progetti\.json$/.test(file.path) || /(?:^|\/)fonti\.json$/.test(file.path)) {
      let data; try { data = JSON.parse(file.content); } catch { throw new Error(`JSON non valido: ${file.path}`); }
      if (!Array.isArray(data.items)) throw new Error(`Manca items in ${file.path}`);
      mergeAux(next, leaf(file.path) === 'progetti.json' ? 'projects' : 'sources', data.items, file.path);
    }
    if (!/^SecondBrain\/Elementi\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}\.md$/.test(file.path)) continue;
    const managed = parseManaged(file.content);
    if (!managed) continue;
    if (leaf(file.path) !== managed.id + '.md') {
      addConflict(next, 'managed_path_mismatch', managed.id, 'L’ID della nota canonica non corrisponde al nome del file: ignorata come attività.', { path: file.path });
      continue;
    }
    if (managed._body_edited && file.mtime) {
      const epoch = typeof file.mtime === 'number' ? file.mtime : Date.parse(file.mtime);
      if (Number.isFinite(epoch) && epoch > 0) {
        managed.updated_at = new Date(epoch).toISOString();
        managed.history = [...managed.history, { at: managed.updated_at, action: 'modificato_in_obsidian', source: 'mtime_file' }];
      }
    }
    next.tombstones = next.tombstones.filter(t => t.id !== managed.id);
    const fp = fingerprint(managed), duplicate = managedInScan.get(managed.id);
    if (duplicate && duplicate.fingerprint !== fp) {
      addConflict(next, 'duplicate_managed', managed.id, 'Due note canoniche condividono un ID con dati diversi. Risolvere il conflitto prima di modificarle.', { path: file.path, item: portable(managed) });
      continue;
    }
    managedInScan.set(managed.id, { fingerprint: fp, path: file.path });
    const previous = byId.get(managed.id);
    if (previous?._dirty && previous._canonical_fingerprint !== fp && fingerprint(previous) !== fp) {
      addConflict(next, 'managed_changed', managed.id, 'La nota canonica è cambiata nel vault durante una modifica locale. Conservata la versione locale.', { path: file.path, item: portable(managed) });
      continue;
    }
    if (previous?._dirty && previous._canonical_fingerprint === fp) continue;
    byId.set(managed.id, { ...managed, _source_fingerprint: previous?._source_fingerprint ?? null, _source_path: previous?._source_path ?? null, _note_path: previous?._note_path ?? file.path, _managed_path: file.path, _managed_hash: file.hash ?? null, _canonical_fingerprint: fp, _dirty: false });
  }
  // Source-only records disappear with a removed file. Unsaved local work is kept
  // as a visible conflict rather than silently discarded.
  for (const [id, item] of byId) {
    if (item._managed_path && !managedInScan.has(id)) {
      if (!next.tombstones.some(t => t.id === id)) next.tombstones.push({ id, path: item._managed_path, deleted_at: next.importedAt });
      if (item._dirty) addConflict(next, 'managed_deleted', id, 'La nota è stata rimossa dal vault: modifica locale conservata, avviso sospeso.');
      else { byId.delete(id); continue; }
      item.reminder = null;
    } else if (!item._managed_path && item._source_path && !originalInScan.has(id) && !item._dirty) byId.delete(id);
  }
  next.items = [...byId.values()];
  next.sources = next.sources.filter(v => files.some(f => f.path === v._source_path));
  next.projects = next.projects.filter(v => files.some(f => f.path === v._source_path));
  return next;
}
export function markSaved(state, hashes = {}) {
  const next = clone(state);
  for (const item of next.items) {
    const path = item._managed_path || `SecondBrain/Elementi/${safeId(item.id)}.md`;
    if (Object.prototype.hasOwnProperty.call(hashes, path)) {
      item._managed_path = path; item._managed_hash = hashes[path];
      item._canonical_fingerprint = fingerprint(item); item._dirty = false;
    }
  }
  return next;
}
export function addItem(state, input, nowIso) {
  const now = stamp(nowIso), next = clone(state);
  const id = input.id || ('ALBE-N-' + (globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`));
  if (next.items.some(item => item.id === id)) throw new Error('L’identificativo esiste già. Modifica l’elemento esistente.');
  const item = normalized({ ...input, id, as_of: input.as_of ?? romeDate(now), updated_at: now, evidence: input.evidence ?? 'confermato', history: [{ at: now, action: 'creato', source: 'inserimento_utente' }] }, { now });
  item._dirty = true; next.items.push(item); return next;
}
export function updateItem(state, id, patch, nowIso) {
  const next = clone(state), index = next.items.findIndex(item => item.id === id), now = stamp(nowIso);
  if (index < 0) throw new Error('Elemento non trovato.');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Modifica non valida.');
  if (patch.id && patch.id !== id) throw new Error('L’identificativo stabile non può essere cambiato.');
  if (Object.keys(patch).some(k => k.startsWith('_'))) throw new Error('I metadati interni non sono modificabili.');
  const old = next.items[index], cleanPatch = clone(patch);
  delete cleanPatch.id; delete cleanPatch.history; delete cleanPatch.updated_at;
  const changes = Object.fromEntries(Object.entries(cleanPatch).filter(([key, value]) => stable(old[key]) !== stable(value)).map(([key, value]) => [key, { before: old[key] ?? null, after: value }]));
  if (!Object.keys(changes).length) return next;
  const candidate = { ...old, ...cleanPatch, updated_at: now, _dirty: true };
  if (Object.prototype.hasOwnProperty.call(cleanPatch, 'due') && old.due !== cleanPatch.due && !Object.prototype.hasOwnProperty.call(cleanPatch, 'reminder')) candidate.reminder = null;
  if (candidate.status === 'completato') candidate.completed_on = romeDate(now);
  if (candidate.status !== 'completato' && old.status === 'completato') candidate.completed_on = null;
  candidate.history = [...old.history, { at: now, action: 'modificato', changes, source: 'inserimento_utente' }];
  next.items[index] = normalized(candidate, { now });
  return next;
}
function sortDue(a, b) { return (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title, 'it'); }
function ended(item, now) { return item.due && (DATE.test(item.due) ? item.due < romeDate(now) : Date.parse(item.due) < Date.parse(now)); }
export function dashboard(state, nowIso) {
  const now = stamp(nowIso), day = romeDate(now);
  const active = state.items.filter(item => !CLOSED.has(item.status));
  const pastAppointments = item => (item.kind === 'appuntamento' || item.kind === 'esito-appuntamento') && ended(item, now);
  const verify = active.filter(item => item.status === 'da_verificare' || item.evidence === 'da_verificare' || pastAppointments(item)).map(item => pastAppointments(item) ? { ...item, display_status: 'esito da verificare' } : item);
  const overdue = active.filter(item => ended(item, now) && item.evidence === 'confermato' && item.status !== 'da_verificare' && !pastAppointments(item));
  const today = active.filter(item => dueDay(item) === day && !pastAppointments(item));
  const upcoming = active.filter(item => dueDay(item) && dueDay(item) > day);
  const projectIds = new Set(state.projects.flatMap(project => project.next_action_ids || []));
  const nextActions = active.filter(item => item.kind !== 'nota' && (projectIds.has(item.id) || (!item.due && item.status === 'aperto' && item.evidence === 'confermato')));
  return { today: today.sort(sortDue), upcoming: upcoming.sort(sortDue), overdue: overdue.sort(sortDue), verify: verify.sort(sortDue), nextActions: nextActions.sort(sortDue) };
}
const STOP = new Set('a ad al allo alla alle agli ai all anche che chi ci con cosa come da dal dalla dalle degli dei del della delle di e è ed essere gli ha hai ho i il in io la le lo mi mio mia miei mie nel nella nelle no non o per quale quali quando quanto qui se si solo sono sto stai sta stiamo state stanno su tra un una uno voglio vorrei ancora punto stato riguardo dimmi sapere sulla sul dell delle'.split(' '));
function tokens(query) { return flat(query).replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t)); }
function queryTokens(query) {
  const out = tokens(query);
  const groups = [ ['bollette', 'bolletta', 'fattura', 'fatture', 'pagare', 'pagamento', 'pagamenti'], ['appuntamenti', 'appuntamento', 'agenda'], ['sospeso', 'sospesi', 'irrisolto', 'irrisolti', 'attivita'], ['casa', 'alloggio', 'affitto'], ['documentario', 'vagli', 'careggine'] ];
  for (const group of groups) if (out.some(t => group.includes(t))) out.push(...group);
  return [...new Set(out)];
}
function documentSnippet(text, query) {
  const stripped = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const chunks = stripped.split(/\n\s*\n/).flatMap(p => p.length > 650 ? p.split(/\n/) : [p]).filter(p => p.trim() && !/^#/.test(p.trim()));
  const qs = tokens(query);
  const ranked = chunks.map((text, i) => ({ text: text.trim(), score: qs.reduce((n, t) => n + (containsWord(text, t) ? 1 : 0), 0), correction: /correzione esplicita|rettifica|stato attuale/i.test(text) ? 1 : 0, i })).filter(c => c.score > 0).sort((a, b) => b.score - a.score || b.correction - a.correction || a.i - b.i);
  return (ranked.length ? ranked.slice(0, 1) : chunks.slice(0, 1).map(text => ({ text }))).map(c => c.text).join('\n\n').slice(0, 1400);
}
function containsWord(text, token) { return flat(text).split(/[^a-z0-9]+/).includes(token); }
function wordCount(text, token) { return flat(text).split(/[^a-z0-9]+/).filter(word => word === token).length; }
export function search(state, query) {
  const qs = queryTokens(query); if (!qs.length) return [];
  const records = [
    ...state.items.map(item => ({ type: 'item', id: item.id, title: item.title, text: item.details, path: item._managed_path || item._note_path || item.note || null, date: item.as_of ?? null, item })),
    ...state.projects.map(project => ({ type: 'project', id: project.id, title: project.name ?? project.title ?? project.id, text: `${project.status ?? ''} ${project.details ?? ''}`, path: project.note ? joined(noteBase(project._source_path || ''), project.note) : project._source_path, date: project.as_of ?? null, project })),
    ...state.documents.map(doc => ({ ...doc, text: doc.text, type: 'document' })),
  ];
  const scored = records.map(record => {
    const title = flat(record.title), body = flat(record.text), id = flat(record.id);
    const direct = tokens(query).reduce((n, t) => n + (containsWord(title, t) ? 12 : 0) + (containsWord(body, t) ? 4 + Math.min(4, wordCount(body, t)) : 0) + (id === t ? 20 : 0), 0);
    const score = direct + qs.reduce((n, t) => n + (containsWord(title, t) ? 2 : 0) + (containsWord(body, t) ? 1 : 0), 0);
    return { ...record, score, text: record.type === 'document' ? documentSnippet(record.text, query) : record.text };
  }).filter(record => record.score > 0).sort((a, b) => b.score - a.score || String(b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title, 'it'));
  const seen = new Set();
  return scored.filter(record => { const key = record.type === 'document' ? stable([record.title, record.text]) : record.type + ':' + record.id; if (seen.has(key)) return false; seen.add(key); return true; });
}
function money(item) { return item.amount == null ? '' : `; importo citato ${item.amount.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${item.currency || ''}`; }
function statusLabel(item, now) {
  if (item.kind === 'appuntamento' && ended(item, now) && !CLOSED.has(item.status)) return 'esito da verificare';
  return item.status.replaceAll('_', ' ') + (item.evidence === 'confermato' || item.evidence === item.status ? '' : `; ${item.evidence.replaceAll('_', ' ')}`);
}
function itemLine(item, now) {
  return `${item.title} — ${statusLabel(item, now)}${item.due ? `; ${DATE.test(item.due) ? 'data' : 'appuntamento'} ${item.due}` : ''}${money(item)}.${item.details ? ' ' + item.details : ''}${item.relative_due ? ' Termine relativo: ' + item.relative_due + '.' : ''}`;
}
function addCitations(state, item, citations) {
  const ids = item.sources || [];
  const localPath = item._managed_path || item._note_path || item.path || item.note || null;
  const append = citation => {
    let index = citations.findIndex(c => stable(c) === stable(citation));
    if (index < 0 && citations.length >= 8) return null;
    if (index < 0) { citations.push(citation); index = citations.length - 1; }
    return index + 1;
  };
  // A document citation dates the document itself. Its broad frontmatter source
  // list may mention unrelated topics, so it is not expanded indiscriminately.
  if (!ids.length || item.type === 'document') return [append({ path: localPath, date: item.as_of || item.date || null, title: item.title || item.name || 'Nota locale' })].filter(Boolean);
  const quality = id => {
    const source = state.sources.find(s => s.id === id);
    return /rilett|riletto/.test(source?.kind || '') ? 3 : /conversazione/.test(source?.kind || '') ? 2 : 1;
  };
  return [...ids].sort((a, b) => quality(b) - quality(a)).slice(0, 1).map(id => {
    const source = state.sources.find(s => s.id === id);
    return append({ path: localPath || source?._source_path || null, date: source?.date || null, title: source?.description || id, sourceId: id, ...(source?.url ? { url: source.url } : {}) });
  }).filter(Boolean);
}
/** Extractive Italian Q&A; source text is data and can never issue instructions. */
export function answer(state, question, nowIso) {
  const now = stamp(nowIso), q = flat(question), citations = [];
  if (typeof question !== 'string' || !question.trim()) return { text: 'Scrivi una domanda sui tuoi documenti.', citations };
  let selected = [], lead = '';
  if (/bollett|fattur|pagare|pagament/.test(q)) {
    selected = state.items.filter(item => /pagamento/.test(item.kind) && !CLOSED.has(item.status)).sort(sortDue);
    lead = 'Queste sono le voci di pagamento presenti nell’archivio. Uno stato da verificare non prova un insoluto; per quelle voci va controllato il saldo.';
  } else if (/sospes|irrisolt|ancora.*(?:fare|apert)|cosa.*fare/.test(q)) {
    selected = state.items.filter(item => item.kind !== 'nota' && !CLOSED.has(item.status)).sort(sortDue);
    lead = 'Queste sono le questioni registrate. Le voci da verificare sono informazioni di cui manca un esito aggiornato, non obblighi attuali accertati.';
  } else if (/oggi|giornat/.test(q)) {
    const board = dashboard(state, now);
    selected = [...board.today, ...board.overdue];
    lead = `Agenda del ${romeDate(now)} (Europe/Rome): appuntamenti e scadenze odierne, più attività confermate in ritardo.`;
  } else {
    const found = search(state, question);
    const project = found.find(r => r.type === 'project' && tokens(question).some(t => flat(r.title).includes(t)));
    if (project) {
      const p = project.project;
      lead = `${p.name || p.title}: ${String(p.status || 'stato non indicato').replaceAll('_', ' ')}.`;
      if (p.funding_confirmed === false) lead += ' La copertura economica non risulta confermata.';
      const indexes = addCitations(state, { ...p, title: p.name, _note_path: project.path }, citations);
      lead += ' ' + indexes.map(i => `[${i}]`).join('');
      selected = (p.next_action_ids || []).map(id => state.items.find(item => item.id === id)).filter(Boolean);
    } else {
      const top = found.filter(r => r.type !== 'project').slice(0, 2);
      if (!top.length) return { text: 'Nei documenti locali non trovo una fonte sufficiente per rispondere. Il dato potrebbe mancare dall’importazione: non ho accesso automatico all’intera cronologia ChatGPT.', citations };
      const lines = top.map(result => {
        if (result.type === 'item') return itemLine(result.item, now) + ' ' + addCitations(state, result.item, citations).map(i => `[${i}]`).join('');
        return `${result.title}${result.date ? ' (nota del ' + result.date + ')' : ' (data della fonte non indicata)'}:\n${result.text}\n` + addCitations(state, result, citations).map(i => `[${i}]`).join('');
      });
      return { text: 'Ho trovato questi passaggi nei documenti locali:\n\n' + lines.join('\n\n'), citations };
    }
  }
  if (!selected.length) return { text: lead + '\n\nNessuna voce corrispondente è presente nell’archivio attuale.', citations };
  const limit = 7;
  const lines = selected.slice(0, limit).map(item => '- ' + itemLine(item, now) + ' ' + addCitations(state, item, citations).map(i => `[${i}]`).join(''));
  if (selected.length > limit) lines.push(`Altre ${selected.length - limit} voci sono consultabili nelle attività e nella ricerca.`);
  return { text: lead + '\n\n' + lines.join('\n\n'), citations };
}
export function reminders(state, nowIso) {
  const now = stamp(nowIso), nowEpoch = Date.parse(now);
  return state.items.filter(item => !CLOSED.has(item.status) && item.reminder?.enabled && item.evidence !== 'ipotesi' && !state.conflicts.some(c => c.id === item.id && ['managed_changed', 'managed_deleted', 'duplicate_managed'].includes(c.type))).flatMap(item => {
    let at; try { at = validInstant(item.reminder.at); } catch { return []; }
    if (Date.parse(at) <= nowEpoch) return [];
    return [{ id: item.id, at, title: state.settings.hideSensitive ? 'Second Brain' : item.title, body: state.settings.hideSensitive ? 'Hai un promemoria personale. Apri l’app per i dettagli.' : `${item.title}. ${statusLabel(item, now)}.`, private: true }];
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
export function exportState(state) {
  const data = restoreState(JSON.stringify(state));
  // Hashes identify a particular vault/provider and are not portable capabilities.
  for (const item of data.items) { delete item._managed_hash; delete item._canonical_fingerprint; }
  return JSON.stringify(data, null, 2);
}
export function restoreState(raw) {
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : clone(raw); } catch { throw new Error('Il backup non è un JSON valido.'); }
  if (!data || data.schema_version !== VERSION || data.timezone !== TIMEZONE) throw new Error('Versione o fuso del backup non supportati.');
  for (const key of ['items', 'projects', 'sources', 'documents', 'conflicts']) if (!Array.isArray(data[key])) throw new Error(`Il backup non contiene ${key}.`);
  const ids = new Set();
  data.items = data.items.map(item => {
    const value = normalized(item);
    if (ids.has(value.id)) throw new Error('Il backup contiene identificativi duplicati.');
    ids.add(value.id);
    for (const key of ['_managed_path', '_source_path', '_note_path']) if (value[key]) validPath(value[key]);
    return value;
  });
  data.settings = { ...createState().settings, ...data.settings };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.settings.dailyDigest)) throw new Error('Orario del riepilogo non valido.');
  if (typeof data.settings.digestEnabled !== 'boolean' || typeof data.settings.hideSensitive !== 'boolean') throw new Error('Impostazioni del backup non valide.');
  data.documents.forEach(doc => { validPath(doc.path); if (typeof doc.text !== 'string') throw new Error('Documento del backup non valido.'); });
  data.tombstones ??= [];
  if (!Array.isArray(data.tombstones)) throw new Error('Registro cancellazioni del backup non valido.');
  data.tombstones.forEach(t => { safeId(t.id); if (t.path) validPath(t.path); });
  data.resolutions ??= [];
  if (!Array.isArray(data.resolutions)) throw new Error('Registro risoluzioni del backup non valido.');
  return data;
}
/** Explicit UI decision, followed by a CAS-protected persist and reconciliation. */
export function resolveConflict(state, index, choice = 'keep_local', nowIso) {
  if (choice !== 'keep_local') throw new Error('Scelta di risoluzione non supportata.');
  const next = clone(state), conflict = next.conflicts[index], now = stamp(nowIso);
  if (!conflict) throw new Error('Conflitto non trovato.');
  const item = next.items.find(i => i.id === conflict.id);
  if (!item) throw new Error('Non esiste una versione locale da conservare. Confronta le note in Obsidian.');
  if (!['source_changed', 'original_changed', 'managed_changed', 'managed_deleted', 'duplicate_id', 'duplicate_managed', 'restore_changed', 'restore_tombstone'].includes(conflict.type)) throw new Error('Questo conflitto richiede il confronto dei file in Obsidian.');
  if (conflict.type === 'managed_changed' || conflict.type === 'duplicate_managed') {
    const path = item._managed_path || `SecondBrain/Elementi/${item.id}.md`;
    const document = next.documents.find(doc => doc.path === path);
    if (!document?.hash) throw new Error('Rileggi il vault prima di confermare la versione locale.');
    item._managed_hash = document.hash;
    const remote = parseManaged(document.text);
    item._canonical_fingerprint = remote ? fingerprint(remote) : null;
  }
  if (conflict.type === 'managed_deleted') {
    item._managed_hash = null;
    next.tombstones = (next.tombstones || []).filter(t => t.id !== item.id);
  }
  if (['source_changed', 'original_changed'].includes(conflict.type) && conflict.incoming) item._source_fingerprint = fingerprint(conflict.incoming);
  item.history = [...(item.history || []), { at: now, action: 'conflitto_risolto', choice, conflict_type: conflict.type, source: 'scelta_utente' }];
  item.updated_at = now; item._dirty = true;
  next.resolutions ??= [];
  next.resolutions.push({ type: conflict.type, id: conflict.id, incoming_fingerprint: stable(conflict.incoming ?? null), choice, at: now });
  next.conflicts.splice(index, 1);
  return next;
}
/** Additive restore: conflicts retain the current vault version for review. */
export function mergeRestore(state, raw, nowIso) {
  const backup = restoreState(raw), next = clone(state), now = stamp(nowIso);
  next.conflicts ??= []; next.tombstones ??= []; next.importedAt = now;
  for (const tombstone of backup.tombstones) {
    if (next.items.some(item => item.id === tombstone.id)) {
      addConflict(next, 'restore_tombstone', tombstone.id, 'Il backup registra una cancellazione, ma esiste un elemento locale. Nessuna cancellazione automatica.', clone(tombstone));
    } else if (!next.tombstones.some(t => t.id === tombstone.id)) next.tombstones.push(clone(tombstone));
  }
  for (const item of backup.items) {
    const local = next.items.find(value => value.id === item.id);
    if (local) {
      if (fingerprint(local) !== fingerprint(item)) addConflict(next, 'restore_changed', item.id, 'Il backup differisce dalla versione locale. Conservata la versione locale.', portable(item));
      continue;
    }
    if (next.tombstones.some(t => t.id === item.id)) {
      addConflict(next, 'restore_deleted', item.id, 'Il backup contiene un elemento cancellato dal vault. Nessuna riattivazione automatica.', portable(item));
      continue;
    }
    const restored = portable(item);
    restored._dirty = true; next.items.push(restored);
  }
  for (const name of ['projects', 'sources']) {
    for (const item of backup[name]) {
      const local = next[name].find(value => value.id === item.id);
      if (!local) next[name].push(clone(item));
      else if (stable(portable(local)) !== stable(portable(item))) addConflict(next, 'restore_' + name, item.id, 'Dati del backup diversi: mantenuta la versione locale.', portable(item));
    }
  }
  // Source documents remain available in the backup for export, but are not
  // presented as current vault documents until physically restored and scanned.
  return next;
}

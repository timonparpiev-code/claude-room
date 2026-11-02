// Хаб: комнаты, сообщения и участники. Без зависимостей, Node 18+.
// Сам Claude здесь не вызывается — хаб только пересылает сообщения.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, 'data', 'rooms.json');
const MAX_MESSAGES = 1000;
const MAX_TEXT = 20000;
const MAX_WAIT_SECONDS = 50;
const ONLINE_MS = 60_000;

// name -> { keyHash, seq, messages, participants: Map, waiters: Set }
const rooms = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

async function load() {
  try {
    const saved = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    for (const [name, r] of Object.entries(saved)) {
      rooms.set(name, { ...r, participants: new Map(), waiters: new Set() });
    }
  } catch {}
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const out = {};
    for (const [name, r] of rooms) out[name] = { keyHash: r.keyHash, seq: r.seq, messages: r.messages };
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, JSON.stringify(out));
  }, 300);
}

// Первый, кто зашёл в комнату, задаёт её ключ. Дальше вход только с тем же ключом.
function openRoom(name, key) {
  if (!/^[\p{L}\p{N}_-]{2,40}$/u.test(name)) {
    throw new HttpError(400, 'Название комнаты: 2–40 символов (буквы, цифры, _ или -)');
  }
  if (!key || key.length < 4) throw new HttpError(401, 'Нужен ключ комнаты (минимум 4 символа)');
  let room = rooms.get(name);
  if (!room) {
    room = { keyHash: sha(key), seq: 0, messages: [], participants: new Map(), waiters: new Set() };
    rooms.set(name, room);
    scheduleSave();
  } else if (room.keyHash !== sha(key)) {
    throw new HttpError(403, 'Неверный ключ комнаты');
  }
  return room;
}

// Заголовки кодируются через encodeURIComponent, потому что кириллицу в заголовках браузер не пропускает.
const header = (req, name) => decodeURIComponent(req.headers[name] || '').trim();

function identify(req, room) {
  const name = header(req, 'x-name').slice(0, 60);
  if (!name) throw new HttpError(400, 'Нужно имя участника');
  const kind = req.headers['x-kind'] === 'claude' ? 'claude' : 'human';
  const owner = header(req, 'x-owner').slice(0, 60) || name;
  room.participants.set(name, { name, kind, owner, lastSeen: Date.now() });
  return { name, kind, owner };
}

function participantsOf(room) {
  const now = Date.now();
  return [...room.participants.values()].map((p) => ({ ...p, online: now - p.lastSeen < ONLINE_MS }));
}

// Long-poll: отдаём новые сообщения сразу, а если их нет — ждём до `seconds`.
function waitForMessages(room, after, seconds, skipAuthor) {
  const pending = () => room.messages.filter((m) => m.id > after && m.author !== skipAuthor);
  const ready = pending();
  if (ready.length || seconds <= 0) return Promise.resolve(ready);
  return new Promise((resolve) => {
    const done = (result) => {
      clearTimeout(timer);
      room.waiters.delete(waiter);
      resolve(result);
    };
    const waiter = () => {
      const got = pending();
      if (got.length) done(got);
    };
    const timer = setTimeout(() => done([]), seconds * 1000);
    room.waiters.add(waiter);
  });
}

function postMessage(room, me, text) {
  text = String(text ?? '').trim();
  if (!text) throw new HttpError(400, 'Пустое сообщение');
  if (text.length > MAX_TEXT) throw new HttpError(413, `Сообщение длиннее ${MAX_TEXT} символов`);
  const message = { id: ++room.seq, author: me.name, kind: me.kind, owner: me.owner, text, ts: Date.now() };
  room.messages.push(message);
  if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
  for (const waiter of [...room.waiters]) waiter();
  scheduleSave();
  return message;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_TEXT * 4) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

async function handleRoom(req, res, url, roomName, resource) {
  const room = openRoom(roomName, header(req, 'x-room-key'));
  const me = identify(req, room);

  if (resource === 'participants') return send(res, 200, { participants: participantsOf(room) });

  if (req.method === 'POST') {
    const body = await readBody(req);
    return send(res, 201, { message: postMessage(room, me, body.text), lastId: room.seq });
  }

  if (req.method === 'GET') {
    let messages;
    if (url.searchParams.has('after')) {
      const after = Number(url.searchParams.get('after')) || 0;
      const wait = Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), MAX_WAIT_SECONDS);
      const skip = url.searchParams.get('others') === '1' ? me.name : null;
      messages = await waitForMessages(room, after, wait, skip);
    } else {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      messages = room.messages.slice(-limit);
    }
    return send(res, 200, { messages, lastId: room.seq, participants: participantsOf(room) });
  }

  throw new HttpError(405, 'Метод не поддерживается');
}

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/bridge.mjs': ['mcp-bridge.mjs', 'text/javascript; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/(messages|participants)$/);
    if (match) return await handleRoom(req, res, url, decodeURIComponent(match[1]), match[2]);
    if (url.pathname === '/health') return send(res, 200, { ok: true });
    const file = STATIC[url.pathname];
    if (file && req.method === 'GET') return send(res, 200, await readFile(path.join(ROOT, file[0])), file[1]);
    throw new HttpError(404, 'Не найдено');
  } catch (err) {
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Внутренняя ошибка' });
    if (!err.status) console.error(err);
  }
});

await load();
server.listen(PORT, () => console.log(`Хаб запущен: http://localhost:${PORT}`));

#!/usr/bin/env node
// Автоответчик: полноценный Claude Code владельца, подключённый к комнате.
// На каждое новое сообщение запускает `claude -p` по подписке владельца с продолжением
// одной и той же сессии, так что Claude помнит всю работу. У него те же инструменты,
// что в обычном Claude Code (файлы, команды, интернет), и он работает в папке WORKDIR.
// Права не спрашиваются: владелец доверяет комнате, в которую входят только по его ссылке.
//
// Настройки берутся из .mcp.json рядом со скриптом (HUB_URL, ROOM, ROOM_KEY, OWNER),
// переменные окружения с теми же именами их переопределяют. Дополнительно:
//   WORKDIR       папка, где Claude работает, по умолчанию ./workspace
//   CLAUDE_BIN    путь к claude, по умолчанию «claude»
//   CLAUDE_MODEL  модель, по умолчанию та же, что в Claude Code
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(ROOT, 'data', 'watch-state.json');
const MCP_FILE = path.join(ROOT, 'data', 'watch-mcp.json');
const SYSTEM_FILE = path.join(ROOT, 'data', 'watch-system.txt');

function loadConfig() {
  let server = {};
  try {
    server = JSON.parse(readFileSync(path.join(ROOT, '.mcp.json'), 'utf8')).mcpServers['claude-room'];
  } catch {}
  const env = server.env || {};
  const pick = (k, d = '') => process.env[k] || env[k] || d;
  return {
    hub: pick('HUB_URL', 'http://localhost:8787').replace(/\/+$/, ''),
    room: pick('ROOM'),
    key: pick('ROOM_KEY'),
    owner: pick('OWNER'),
    workdir: path.resolve(ROOT, pick('WORKDIR', 'workspace')),
    bin: pick('CLAUDE_BIN', 'claude'),
    model: pick('CLAUDE_MODEL'),
    server,
  };
}

const cfg = loadConfig();
const ME = `Claude (${cfg.owner})`;
const BATCH_MS = 2500; // подождать, вдруг пишут несколько сообщений подряд
const MAX_RUNS_PER_10_MIN = 20; // предохранитель от бесконечной переписки двух Claude
const CLAUDE_STREAK_LIMIT = 6; // подряд только сообщения Claude — значит, люди молчат, пора остановиться

if (!cfg.room || !cfg.key || !cfg.owner) {
  console.error('Не заданы ROOM, ROOM_KEY или OWNER (в .mcp.json или переменных окружения).');
  process.exit(1);
}
mkdirSync(cfg.workdir, { recursive: true });
mkdirSync(path.dirname(STATE_FILE), { recursive: true });

// Тот же мост, что у обычного Claude Code, но в режиме доверенной комнаты:
// так Claude может писать в комнату о ходе работы, не дожидаясь конца задачи.
writeFileSync(
  MCP_FILE,
  JSON.stringify({
    mcpServers: {
      'claude-room': {
        command: cfg.server.command || process.execPath,
        args: cfg.server.args || [path.join(ROOT, 'mcp-bridge.mjs')],
        env: { HUB_URL: cfg.hub, ROOM: cfg.room, ROOM_KEY: cfg.key, OWNER: cfg.owner, TRUST_ROOM: '1' },
      },
    },
  }),
);

const state = (() => {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
})();
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state));

async function api(method, resource, body) {
  const res = await fetch(`${cfg.hub}/api/rooms/${encodeURIComponent(cfg.room)}/${resource}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-room-key': encodeURIComponent(cfg.key),
      'x-name': encodeURIComponent(ME),
      'x-kind': 'claude',
      'x-owner': encodeURIComponent(cfg.owner),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Хаб ответил ${res.status}`);
  return data;
}

const who = (m) => (m.kind === 'claude' ? `${m.author} [Claude пользователя ${m.owner}]` : `${m.author} [человек]`);
const time = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const formatMessages = (list) => list.map((m) => `[${time(m.ts)}] ${who(m)}:\n${m.text}`).join('\n\n');

const SYSTEM = `Ты — «${ME}», Claude Code пользователя ${cfg.owner}, подключённый к общей комнате «${cfg.room}» платформы Claude Room.
В комнате ${cfg.owner}, его друзья по совместному стартапу и их собственные Claude (имена вида «Claude (Имя)»). Вы одна команда.
Люди пишут тебе только через комнату, твой ответ автоматически уходит туда же. Работай как обычный Claude Code: читай и меняй файлы, запускай команды, ищи в интернете.
Твоя рабочая папка — ${cfg.workdir}. Работай в ней, если тебя явно не попросили о другом.
Если задача долгая, коротко напиши в комнату через room_send, что начал, и сообщай о важных шагах.
Итоговый ответ пиши кратко и по делу, на языке собеседника, без подписи.
Если отвечать не нужно (поблагодарили, обращаются не к тебе, другой Claude лишь подтверждает), ответь ровно одним словом: SKIP`;
// Через файл: многострочный текст в аргументах cmd.exe не передать.
writeFileSync(SYSTEM_FILE, SYSTEM);

// Аргументы для cmd.exe: без кавычек пробелы и пустые строки потеряются.
const quote = (a) => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`);

function runClaude(prompt, resume) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--mcp-config', MCP_FILE,
      '--strict-mcp-config',
      '--append-system-prompt-file', SYSTEM_FILE,
      ...(cfg.model ? ['--model', cfg.model] : []),
      ...(resume ? ['--resume', resume] : []),
    ];
    // npm ставит claude как claude.cmd, а его на Windows можно запустить только через shell.
    const shell = process.platform === 'win32' && !cfg.bin.toLowerCase().endsWith('.exe');
    const child = spawn(shell ? quote(cfg.bin) : cfg.bin, shell ? args.map(quote) : args, {
      cwd: cfg.workdir,
      shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('error', reject);
    child.on('close', () => {
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(err.trim() || out.trim() || 'claude ничего не ответил'));
      }
    });
    child.stdin.end(prompt);
  });
}

async function ask(prompt) {
  let result = state.sessionId ? await runClaude(prompt, state.sessionId).catch(() => null) : null;
  // Сессия могла пропасть (другой компьютер, очистка) — начинаем новую.
  if (!result || !result.session_id) result = await runClaude(prompt, null);
  state.sessionId = result.session_id;
  saveState();
  if (result.is_error) throw new Error(result.result || result.subtype || 'ошибка Claude');
  return String(result.result || '').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runTimes = [];

// Передаёт Claude сообщения после afterId и возвращает id последнего из них.
async function respond(afterId) {
  const data = await api('GET', 'messages?limit=50');
  const fresh = data.messages.filter((m) => m.id > afterId && m.author !== ME);
  const lastSeen = data.messages.at(-1)?.id ?? afterId;
  if (!fresh.length) return lastSeen;

  const streak = data.messages.slice().reverse().findIndex((m) => m.kind !== 'claude');
  if (streak === -1 || streak >= CLAUDE_STREAK_LIMIT) {
    console.log('Подряд одни сообщения Claude — молчу, пока не напишет человек.');
    return lastSeen;
  }
  const now = Date.now();
  while (runTimes.length && now - runTimes[0] > 10 * 60_000) runTimes.shift();
  if (runTimes.length >= MAX_RUNS_PER_10_MIN) {
    console.log('Слишком много запусков за 10 минут — пропускаю.');
    return lastSeen;
  }
  runTimes.push(now);

  // В новой сессии Claude ещё не видел переписку — показываем ему последние сообщения целиком.
  const shown = state.sessionId ? fresh : data.messages.slice(-30);
  const people = data.participants.filter((p) => p.online).map((p) => `- ${p.name}`).join('\n');
  const prompt = `Новые сообщения в комнате (онлайн:\n${people}):\n\n${formatMessages(shown)}`;

  console.log(`[${time(now)}] Новое от ${fresh.at(-1).author}, работаю...`);
  const text = await ask(prompt);
  if (!text || /^SKIP\.?$/i.test(text)) {
    console.log('  отвечать не нужно');
  } else {
    await api('POST', 'messages', { text });
    console.log(`  ответил: ${text.slice(0, 80).replace(/\s+/g, ' ')}${text.length > 80 ? '…' : ''}`);
  }
  return lastSeen;
}

async function main() {
  let { lastId } = await api('GET', 'messages?limit=1');
  console.log(`Автоответчик ${ME} следит за комнатой «${cfg.room}» на ${cfg.hub}.`);
  console.log(`Рабочая папка: ${cfg.workdir}. Остановить: Ctrl+C.`);
  for (;;) {
    try {
      const data = await api('GET', `messages?after=${lastId}&wait=45&others=1`);
      if (!data.messages.length) {
        lastId = Math.max(lastId, data.lastId);
        continue;
      }
      await sleep(BATCH_MS);
      // Сообщения, пришедшие, пока Claude работал, вызовут следующий круг.
      lastId = await respond(lastId);
    } catch (err) {
      console.error(`Ошибка: ${err.message}. Повтор через 10 с.`);
      await sleep(10_000);
    }
  }
}

main();

import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { extractUrls, kindOf, extractVideoFrames, fetchLinkPreview } from './lib/media.js';
import { engines, ideate, followUp } from './lib/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3939);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || '';
const DEFAULT_ENGINE = process.env.DEFAULT_ENGINE || 'auto';
const ENGINES = new Set(['auto', 'claude', 'codex']);

const store = new Store(DATA_DIR);
const app = express();
app.disable('x-powered-by');

// ---------- 접근 제어 (ACCESS_TOKEN을 설정했을 때만) ----------

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : '';
}

app.use(express.urlencoded({ extended: false, limit: '1mb' }));

if (ACCESS_TOKEN) {
  app.post('/login', (req, res) => {
    if (safeEqual(req.body.token || '', ACCESS_TOKEN)) {
      res.cookie('mi_token', ACCESS_TOKEN, { httpOnly: true, sameSite: 'lax', maxAge: 400 * 24 * 3600 * 1000, secure: req.secure });
      return res.redirect('/');
    }
    res.status(401).send(loginPage('토큰이 맞지 않습니다.'));
  });
  app.use((req, res, next) => {
    const open = ['/manifest.webmanifest', '/icons/', '/sw.js', '/style.css'];
    if (open.some((p) => req.path.startsWith(p))) return next();
    if (safeEqual(readCookie(req, 'mi_token'), ACCESS_TOKEN)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
    res.status(401).send(loginPage());
  });
}

function loginPage(msg = '') {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>번뜩 · 로그인</title><link rel="stylesheet" href="/style.css"></head>
<body class="login"><form method="post" action="/login"><h1>번뜩</h1><p>서버에 설정한 ACCESS_TOKEN을 입력하세요.</p>
<input name="token" type="password" autofocus autocomplete="current-password"><button>들어가기</button>
${msg ? `<p class="err">${msg}</p>` : ''}</form></body></html>`;
}

// ---------- 정적 파일 ----------

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use('/uploads', express.static(store.uploadDir, { maxAge: '7d', immutable: true }));
app.use(express.json({ limit: '2mb' }));

// ---------- 업로드 ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: store.uploadDir,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 10).replace(/[^.\w]/g, '');
      cb(null, `${Store.newId()}${ext}`);
    },
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 300) * 1024 * 1024, files: 10 },
});

// 브라우저가 multipart 파일 이름을 latin1로 보내는 경우를 바로잡는다.
function fixName(name = '') {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('�') ? name : decoded;
  } catch {
    return name;
  }
}

async function createIdea({ text = '', files = [], engine = DEFAULT_ENGINE, source = 'app' }) {
  // multipart 전송은 줄바꿈을 CRLF로 바꿔 보내므로 사용자가 입력한 LF로 되돌린다.
  text = String(text).replace(/\r\n?/g, '\n');
  const id = Store.newId();
  const attachments = [];
  for (const f of files) {
    const kind = kindOf(f.mimetype);
    const att = {
      file: f.filename,
      originalName: fixName(f.originalname),
      mime: f.mimetype,
      size: f.size,
      kind,
      frames: [],
    };
    if (kind === 'video') {
      att.frames = await extractVideoFrames(f.path, store.uploadDir, path.parse(f.filename).name);
    }
    attachments.push(att);
  }
  const now = new Date().toISOString();
  const idea = store.create({
    id,
    createdAt: now,
    updatedAt: now,
    source,
    raw: { text, urls: extractUrls(text), attachments },
    linkPreviews: [],
    status: 'queued',
    engine: ENGINES.has(engine) ? engine : DEFAULT_ENGINE,
    engineUsed: null,
    error: null,
    ideation: null,
    ideationHistory: [],
    thread: [],
    threadStatus: null,
  });
  enqueue({ type: 'ideate', id });
  return idea;
}

// ---------- 작업 대기열 (CLI는 무거워서 한 번에 하나씩 실행) ----------

const queue = [];
let busy = false;

function enqueue(job) {
  queue.push(job);
  pump();
}

async function pump() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    if (job.type === 'ideate') await runIdeation(job.id);
    if (job.type === 'thread') await runThread(job.id, job.engine);
  } catch (e) {
    console.error('[queue]', e);
  } finally {
    busy = false;
    setImmediate(pump);
  }
}

const aiOpts = (engine) => ({ engine, uploadPath: (f) => store.uploadPath(f), workDir: DATA_DIR });

async function runIdeation(id) {
  let idea = store.update(id, (i) => {
    i.status = 'running';
    i.error = null;
  });
  if (!idea) return;
  if (idea.raw.urls.length && !idea.linkPreviews.length) {
    const previews = await Promise.all(idea.raw.urls.slice(0, 5).map(fetchLinkPreview));
    idea = store.update(id, (i) => (i.linkPreviews = previews));
  }
  try {
    const { engine, ideation } = await ideate(idea, store.list(), aiOpts(idea.engine));
    store.update(id, (i) => {
      if (i.ideation) i.ideationHistory.push({ at: i.updatedAt, engine: i.engineUsed, ideation: i.ideation });
      i.ideation = ideation;
      i.engineUsed = engine;
      i.status = 'done';
    });
  } catch (e) {
    store.update(id, (i) => {
      i.status = 'error';
      i.error = e.message;
    });
  }
}

async function runThread(id, engine) {
  const idea = store.update(id, (i) => (i.threadStatus = 'running'));
  if (!idea) return;
  const last = idea.thread[idea.thread.length - 1];
  if (!last || last.role !== 'user') return store.update(id, (i) => (i.threadStatus = null));
  try {
    const context = { ...idea, thread: idea.thread.slice(0, -1) };
    const r = await followUp(context, last.text, aiOpts(engine));
    store.update(id, (i) => {
      i.thread.push({ role: 'ai', text: r.text, engine: r.engine, at: new Date().toISOString() });
      i.threadStatus = null;
    });
  } catch (e) {
    store.update(id, (i) => {
      i.thread.push({ role: 'ai', text: `응답을 받지 못했습니다.\n${e.message}`, error: true, at: new Date().toISOString() });
      i.threadStatus = null;
    });
  }
}

// 재시작 시 남아 있던 작업 이어서 처리
for (const i of store.list().reverse()) {
  if (i.status === 'queued') queue.push({ type: 'ideate', id: i.id });
  if (i.threadStatus === 'queued') queue.push({ type: 'thread', id: i.id, engine: i.engine });
}
pump();

// ---------- API ----------

function summary(i) {
  return {
    id: i.id,
    createdAt: i.createdAt,
    source: i.source,
    text: i.raw.text,
    attachments: i.raw.attachments.map(({ file, kind, originalName, frames }) => ({ file, kind, originalName, frames })),
    urls: i.raw.urls,
    status: i.status,
    error: i.error,
    title: i.ideation?.title || null,
    summary: i.ideation?.summary || null,
    tags: i.ideation?.tags || [],
    type: i.ideation?.type || null,
    threadStatus: i.threadStatus,
  };
}

function matches(i, q) {
  if (!q) return true;
  const hay = [i.raw.text, i.ideation && JSON.stringify(i.ideation), ...(i.linkPreviews || []).map((l) => `${l.title} ${l.description}`), ...i.thread.map((m) => m.text)]
    .join(' ')
    .toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

app.get('/api/engines', (req, res) => {
  const e = engines(req.query.refresh === '1');
  res.json({ default: DEFAULT_ENGINE, claude: e.claude, codex: e.codex, mock: e.mock.available });
});

app.get('/api/ideas', (req, res) => {
  const { q = '', tag = '' } = req.query;
  const items = store
    .list()
    .filter((i) => matches(i, q))
    .filter((i) => !tag || (i.ideation?.tags || []).includes(tag));
  const tags = {};
  for (const i of store.list()) for (const t of i.ideation?.tags || []) tags[t] = (tags[t] || 0) + 1;
  res.json({ items: items.map(summary), tags: Object.entries(tags).sort((a, b) => b[1] - a[1]), busy, queued: queue.length });
});

app.get('/api/ideas/:id', (req, res) => {
  const idea = store.get(req.params.id);
  if (!idea) return res.status(404).json({ error: 'not found' });
  const titles = Object.fromEntries(store.list().map((i) => [i.id, i.ideation?.title || i.raw.text.slice(0, 30) || '(첨부 기록)']));
  res.json({ ...idea, connectionTitles: titles });
});

app.post('/api/ideas', upload.array('files', 10), async (req, res) => {
  const text = req.body.text ?? '';
  if (!text.trim() && !(req.files || []).length) return res.status(400).json({ error: '내용이 비어 있습니다' });
  const idea = await createIdea({ text, files: req.files || [], engine: req.body.engine });
  res.status(201).json(summary(idea));
});

app.post('/api/ideas/:id/ideate', (req, res) => {
  const engine = ENGINES.has(req.body?.engine) ? req.body.engine : undefined;
  const idea = store.update(req.params.id, (i) => {
    i.status = 'queued';
    if (engine) i.engine = engine;
  });
  if (!idea) return res.status(404).json({ error: 'not found' });
  enqueue({ type: 'ideate', id: idea.id });
  res.json(summary(idea));
});

app.post('/api/ideas/:id/thread', (req, res) => {
  const message = String(req.body?.message || '').trim();
  if (!message) return res.status(400).json({ error: '메시지가 비어 있습니다' });
  const engine = ENGINES.has(req.body?.engine) ? req.body.engine : DEFAULT_ENGINE;
  const cur = store.get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  if (cur.threadStatus) return res.status(409).json({ error: '이전 질문에 대한 답을 기다리는 중입니다' });
  const idea = store.update(req.params.id, (i) => {
    i.thread.push({ role: 'user', text: message, at: new Date().toISOString() });
    i.threadStatus = 'queued';
  });
  enqueue({ type: 'thread', id: idea.id, engine });
  res.json({ ok: true });
});

app.delete('/api/ideas/:id', (req, res) => {
  res.json({ ok: store.remove(req.params.id) });
});

// 전체 기록을 마크다운으로 내보내기
app.get('/api/export.md', (_req, res) => {
  const out = ['# 번뜩 기록 내보내기', '', `내보낸 시각: ${new Date().toISOString()}`, ''];
  for (const i of store.list()) {
    const d = i.ideation;
    out.push(`## ${d?.title || '(아이데이션 전)'}`, '', `- 기록: ${i.createdAt}`, `- id: ${i.id}`);
    if (d?.tags?.length) out.push(`- 태그: ${d.tags.map((t) => `#${t}`).join(' ')}`);
    out.push('', '### 원문', '', '```', i.raw.text, '```', '');
    for (const a of i.raw.attachments) out.push(`- 첨부(${a.kind}): ${a.originalName} → uploads/${a.file}`);
    if (d) {
      out.push('', '### 아이데이션', '', d.summary, '', `**해석** ${d.interpretation}`, '');
      out.push(`- 문제: ${d.concept.problem}`, `- 대상: ${d.concept.target}`, `- 방법: ${d.concept.solution}`, `- 차별점: ${d.concept.difference}`, '');
      out.push('**발전 방향**', ...d.directions.map((x) => `- ${x.name}: ${x.description}`), '');
      out.push('**질문**', ...d.questions.map((x) => `- ${x}`), '');
      out.push('**다음 행동**', ...d.next_steps.map((x) => `- [ ] ${x}`), '');
    }
    if (i.thread.length) {
      out.push('### 이어서 나눈 대화', '');
      for (const m of i.thread) out.push(`**${m.role === 'user' ? '나' : 'AI'}**: ${m.text}`, '');
    }
    out.push('---', '');
  }
  res.type('text/markdown; charset=utf-8').set('Content-Disposition', 'attachment; filename="memory-idea-export.md"').send(out.join('\n'));
});

// ---------- 다른 앱에서 공유하기 (PWA Web Share Target) ----------

app.post('/share', upload.array('files', 10), async (req, res) => {
  const parts = [req.body.title, req.body.text, req.body.url].filter((s) => s && String(s).trim());
  const text = [...new Set(parts)].join('\n');
  if (!text && !(req.files || []).length) return res.redirect(303, '/');
  const idea = await createIdea({ text, files: req.files || [], source: 'share' });
  res.redirect(303, `/#/idea/${idea.id}`);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message });
});

app.listen(PORT, HOST, () => {
  const e = engines();
  console.log(`번뜩 서버 실행 중: http://localhost:${PORT}`);
  console.log(`데이터 위치: ${DATA_DIR}`);
  console.log(`AI 엔진: claude ${e.claude.available ? '사용 가능' : '없음'} · codex ${e.codex.available ? '사용 가능' : '없음'}${e.mock.available ? ' · MOCK 모드' : ''}`);
  if (!ACCESS_TOKEN && HOST !== '127.0.0.1') console.log('주의: ACCESS_TOKEN이 없어 같은 네트워크의 누구나 접속할 수 있습니다.');
});

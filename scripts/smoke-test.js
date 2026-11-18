// MOCK_AI=1 로 서버를 띄워 기록 저장 → 아이데이션 → 후속 대화 → 내보내기 흐름을 확인한다.
// 실행: npm test
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseIdeation } from '../lib/ai.js';
import { htmlToText } from '../lib/links.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-idea-test-'));
const port = 4000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

// 1) 파서 단위 확인: 코드 블록과 앞뒤 잡담이 섞여도 JSON을 꺼낸다
const parsed = parseIdeation('좋아요!\n```json\n{"title":"T","tags":"하나","directions":["A"]}\n```\n끝');
assert.equal(parsed.title, 'T');
assert.deepEqual(parsed.tags, ['하나']);
assert.deepEqual(parsed.directions, [{ name: 'A', description: '' }]);

// 본문 추출: 메뉴와 스크립트는 버리고 기사 본문만 남긴다
const extracted = htmlToText('<html><body><nav>메뉴 홈 로그인</nav><script>alert(1)</script><article><h1>제목</h1><p>첫 문단 &amp; 내용</p><p>둘째 문단</p></article><footer>저작권</footer></body></html>');
assert.ok(extracted.includes('첫 문단 & 내용'));
assert.ok(!extracted.includes('메뉴') && !extracted.includes('alert') && !extracted.includes('저작권'));

// ---------- 가짜 웹사이트 + 가짜 텔레그램 API ----------
const pngBytes = fs.readFileSync(path.join(root, 'public/icons/icon-192.png'));
const tg = { updates: [], sent: [], nextUpdate: 1, nextMsg: 1000 };
const article = `<html><head><title>아이디어 노트 기법</title><meta property="og:description" content="메모하는 법"></head>
<body><header>사이트 메뉴</header><article><p>${'아이디어를 잊지 않으려면 떠오른 즉시 적어야 합니다. '.repeat(20)}</p><p>핵심은 분류보다 수집 속도입니다.</p></article></body></html>`;
// "안녕하세요"를 EUC-KR로 인코딩한 바이트
const eucKr = Buffer.concat([Buffer.from('<html><head><meta charset="euc-kr"></head><body><p>'), Buffer.from([0xbe, 0xc8, 0xb3, 0xe7, 0xc7, 0xcf, 0xbc, 0xbc, 0xbf, 0xe4]), Buffer.from('</p></body></html>')]);

const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/article') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(article);
  if (u.pathname === '/euckr') return res.writeHead(200, { 'content-type': 'text/html' }).end(eucKr);
  if (u.pathname.startsWith('/file/')) return res.writeHead(200, { 'content-type': 'image/png' }).end(pngBytes);
  const m = u.pathname.match(/^\/botTEST\/(\w+)$/);
  if (!m) return res.writeHead(404).end();
  let body = '';
  for await (const c of req) body += c;
  const p = body ? JSON.parse(body) : {};
  const ok = (result) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
  switch (m[1]) {
    case 'getMe': return ok({ id: 1, username: 'test_bot' });
    case 'getUpdates': {
      const out = tg.updates.filter((x) => x.update_id >= (p.offset || 0));
      tg.updates = [];
      return ok(out);
    }
    case 'getFile': return ok({ file_id: p.file_id, file_path: `photos/${p.file_id}.png` });
    case 'sendMessage': {
      const msg = { message_id: tg.nextMsg++, ...p };
      tg.sent.push(msg);
      return ok({ message_id: msg.message_id, chat: { id: p.chat_id } });
    }
    default: return ok(true);
  }
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const mockBase = `http://127.0.0.1:${mock.address().port}`;
const pushUpdate = (message) => tg.updates.push({ update_id: tg.nextUpdate++, message: { date: 0, chat: { id: message.from.id, type: 'private' }, ...message } });

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    MOCK_AI: '1', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir,
    TELEGRAM_BOT_TOKEN: 'TEST', TELEGRAM_API_BASE: mockBase, TELEGRAM_ALLOWED_USERS: '111',
    TELEGRAM_POLL_TIMEOUT: '0', PUBLIC_URL: 'https://example.test',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`시간 초과: ${label}`);
}
const json = (p, o) => fetch(base + p, o).then((r) => r.json());

try {
  await waitFor(() => fetch(`${base}/api/engines`).then((r) => r.ok), '서버 시작');

  // 2) 텍스트 원문이 공백과 줄바꿈까지 그대로 저장되는지
  const rawText = '  길 가다 생각남\n버스 정류장에서 기다리는 시간에 할 수 있는 1분 게임?  ';
  const fd = new FormData();
  fd.append('text', rawText);
  const img = fs.readFileSync(path.join(root, 'public/icons/icon-192.png'));
  fd.append('files', new Blob([img], { type: 'image/png' }), '캡처.png');
  const created = await json('/api/ideas', { method: 'POST', body: fd });
  assert.equal(created.text, rawText);
  assert.equal(created.attachments[0].originalName, '캡처.png');

  const done = await waitFor(async () => {
    const d = await json(`/api/ideas/${created.id}`);
    return d.status === 'done' ? d : null;
  }, '아이데이션 완료');
  assert.equal(done.raw.text, rawText);
  assert.ok(done.ideation.title);
  assert.equal(done.engineUsed, 'mock');

  // 3) 영상 첨부: ffmpeg가 있으면 프레임 3장이 만들어져야 한다
  if (spawnSync('ffmpeg', ['-version']).status === 0) {
    const vid = path.join(dataDir, 'test.mp4');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', vid]);
    const vfd = new FormData();
    vfd.append('text', '');
    vfd.append('files', new Blob([fs.readFileSync(vid)], { type: 'video/mp4' }), 'clip.mp4');
    const v = await json('/api/ideas', { method: 'POST', body: vfd });
    assert.equal(v.attachments[0].kind, 'video');
    assert.equal(v.attachments[0].frames.length, 3);
  }

  // 4) 공유하기(Web Share Target) 경로
  const sfd = new FormData();
  sfd.append('title', '좋은 글');
  sfd.append('text', '복사한 문장');
  const shareRes = await fetch(`${base}/share`, { method: 'POST', body: sfd, redirect: 'manual' });
  assert.equal(shareRes.status, 303);
  assert.match(shareRes.headers.get('location'), /^\/#\/idea\//);

  // 5) 이어서 발전시키기
  await json(`/api/ideas/${created.id}/thread`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: '수익 모델은?' }),
  });
  const withThread = await waitFor(async () => {
    const d = await json(`/api/ideas/${created.id}`);
    return d.thread.length === 2 ? d : null;
  }, '후속 대화 응답');
  assert.equal(withThread.thread[0].text, '수익 모델은?');
  assert.equal(withThread.thread[1].role, 'ai');

  // 6) 다시 아이데이션하면 이전 결과가 기록에 남는다
  await json(`/api/ideas/${created.id}/ideate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const again = await waitFor(async () => {
    const d = await json(`/api/ideas/${created.id}`);
    return d.status === 'done' && d.ideationHistory.length === 1 ? d : null;
  }, '재아이데이션');
  assert.ok(again.ideation);

  // 7) 검색과 내보내기
  const search = await json('/api/ideas?q=' + encodeURIComponent('정류장'));
  assert.equal(search.items.length, 1);
  const md = await fetch(`${base}/api/export.md`).then((r) => r.text());
  assert.ok(md.includes(rawText));

  // 8) 링크를 따라가 본문을 읽고, 정리 결과와 분류가 붙는다
  const lfd = new FormData();
  lfd.append('text', `이 글 좋음 ${mockBase}/article\n${mockBase}/euckr`);
  const lc = await json('/api/ideas', { method: 'POST', body: lfd });
  const ld = await waitFor(async () => {
    const d = await json(`/api/ideas/${lc.id}`);
    return d.status === 'done' ? d : null;
  }, '링크 아이데이션');
  assert.equal(ld.links.length, 2);
  assert.equal(ld.links[0].title, '아이디어 노트 기법');
  assert.ok(ld.links[0].content.includes('핵심은 분류보다 수집 속도입니다'));
  assert.ok(!ld.links[0].content.includes('사이트 메뉴'));
  assert.ok(ld.links[1].content.includes('안녕하세요'), 'EUC-KR 페이지 디코딩');
  assert.equal(ld.ideation.link_summaries.length, 2);
  assert.equal(ld.category, '콘텐츠');

  // 9) 분류 목록과 분류 필터, 직접 분류 바꾸기
  const listed = await json('/api/ideas?category=' + encodeURIComponent('콘텐츠'));
  assert.ok(listed.items.every((i) => i.category === '콘텐츠'));
  assert.ok(listed.categories.some(([c]) => c === '콘텐츠'));
  await json(`/api/ideas/${lc.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ category: '공부' }) });
  await json(`/api/ideas/${lc.id}/ideate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const locked = await waitFor(async () => {
    const d = await json(`/api/ideas/${lc.id}`);
    return d.status === 'done' && d.ideationHistory.length === 1 ? d : null;
  }, '분류 고정 후 재아이데이션');
  assert.equal(locked.category, '공부');

  // 10) 텔레그램: 등록 안 된 사용자는 ID 안내만 받는다
  pushUpdate({ message_id: 1, from: { id: 999 }, text: '안녕' });
  await waitFor(async () => tg.sent.find((m) => m.chat_id === 999 && m.text.includes('999')), '미등록 사용자 안내');

  // 11) 텔레그램: 글 + 링크 + 사진을 보내면 저장 → 확인 답장 → 정리 결과 전송
  pushUpdate({
    message_id: 2, from: { id: 111 },
    caption: `텔레그램 메모 ${mockBase}/article`,
    photo: [{ file_id: 'small', file_size: 10 }, { file_id: 'big', file_size: 20 }],
  });
  await waitFor(async () => tg.sent.find((m) => m.chat_id === 111 && m.text.startsWith('기록했어요')), '저장 확인 답장');
  const result = await waitFor(async () => tg.sent.find((m) => m.chat_id === 111 && m.parse_mode === 'HTML'), '정리 결과 메시지');
  assert.ok(result.text.includes('링크 정리'));
  assert.ok(result.text.includes('https://example.test/#/idea/'));
  assert.equal(result.reply_parameters.message_id, 2);
  const tgIdea = (await json('/api/ideas')).items.find((i) => i.source === 'telegram');
  assert.equal(tgIdea.text, `텔레그램 메모 ${mockBase}/article`);
  assert.equal(tgIdea.attachments.length, 1);
  assert.equal(tgIdea.attachments[0].kind, 'image');

  // 12) 정리 결과에 답장하면 이어서 대화하고, 답을 텔레그램으로 돌려준다
  pushUpdate({ message_id: 3, from: { id: 111 }, text: '더 작게 시작하려면?', reply_to_message: { message_id: result.message_id } });
  const answer = await waitFor(async () => tg.sent.find((m) => m.reply_parameters?.message_id === 3), '후속 답변');
  assert.ok(answer.text.includes('테스트 응답'));
  const tgDetail = await json(`/api/ideas/${tgIdea.id}`);
  assert.equal(tgDetail.thread[0].text, '더 작게 시작하려면?');
  assert.equal(tgDetail.thread[0].via, 'telegram');

  // 13) 앨범(사진 여러 장 묶음)은 기록 하나로 합친다
  for (const [i, id] of ['a1', 'a2'].entries()) {
    pushUpdate({ message_id: 10 + i, from: { id: 111 }, media_group_id: 'g1', ...(i === 0 ? { caption: '앨범' } : {}), photo: [{ file_id: id, file_size: 10 }] });
  }
  const album = await waitFor(async () => (await json('/api/ideas')).items.find((i) => i.text === '앨범'), '앨범 기록');
  assert.equal(album.attachments.length, 2);

  // 14) 삭제하면 첨부 파일도 지워진다
  const file = path.join(dataDir, 'uploads', created.attachments[0].file);
  assert.ok(fs.existsSync(file));
  await json(`/api/ideas/${created.id}`, { method: 'DELETE' });
  assert.ok(!fs.existsSync(file));

  console.log('모든 확인 통과');
} finally {
  server.kill();
  mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

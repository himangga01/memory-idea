// MOCK_AI=1 로 서버를 띄워 기록 저장 → 아이데이션 → 후속 대화 → 내보내기 흐름을 확인한다.
// 실행: npm test
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parseIdeation } from '../lib/ai.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-idea-test-'));
const port = 4000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;

// 1) 파서 단위 확인: 코드 블록과 앞뒤 잡담이 섞여도 JSON을 꺼낸다
const parsed = parseIdeation('좋아요!\n```json\n{"title":"T","tags":"하나","directions":["A"]}\n```\n끝');
assert.equal(parsed.title, 'T');
assert.deepEqual(parsed.tags, ['하나']);
assert.deepEqual(parsed.directions, [{ name: 'A', description: '' }]);

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: { ...process.env, MOCK_AI: '1', PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir },
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

  // 8) 삭제하면 첨부 파일도 지워진다
  const file = path.join(dataDir, 'uploads', created.attachments[0].file);
  assert.ok(fs.existsSync(file));
  await json(`/api/ideas/${created.id}`, { method: 'DELETE' });
  assert.ok(!fs.existsSync(file));

  console.log('모든 확인 통과');
} finally {
  server.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

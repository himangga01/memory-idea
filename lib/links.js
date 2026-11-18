// 링크를 따라가 본문을 읽어 온다. 결과는 AI 아이데이션의 재료가 되고 기록에도 저장된다.
// 실패해도 링크 원문은 그대로 남고, AI에게는 "본문을 가져오지 못함"으로 전달된다.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_CONTENT = Number(process.env.LINK_MAX_CHARS || 50000);
const TIMEOUT = 15000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// ---------- HTML → 텍스트 ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—' };

export function decodeEntities(s = '') {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function clean(s = '') {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function metaContent(html, names) {
  for (const n of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`,
      'i',
    );
    const m = html.match(re);
    if (m) return clean(m[1] ?? m[2]);
  }
  return '';
}

/** 광고, 메뉴, 스크립트를 걷어 내고 읽을 만한 본문 텍스트만 남긴다. */
export function htmlToText(html) {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|canvas|form|button|select)\b[\s\S]*?<\/\1>/gi, ' ');

  // 본문 후보: <article>, <main>, 흔한 본문 클래스. 충분히 길면 그것만 쓴다.
  const candidates = [];
  for (const re of [
    /<article\b[\s\S]*?<\/article>/gi,
    /<main\b[\s\S]*?<\/main>/gi,
    /<div[^>]+(?:id|class)=["'][^"']*(?:se-main-container|post-content|post_content|entry-content|article-body|article_body|articleBody|newsct_article|news_body|tt_article_useless_p_margin|contents_style)[^"']*["'][\s\S]*$/gi,
  ]) {
    for (const m of h.match(re) || []) candidates.push(m);
  }
  const strip = (x) =>
    x.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');
  let body = h.match(/<body\b[\s\S]*<\/body>/i)?.[0] || h;
  const best = candidates.map(strip).sort((a, b) => textLen(b) - textLen(a))[0];
  body = best && textLen(best) > 300 ? best : strip(body);

  const text = decodeEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre|section|article|figcaption)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<h([1-6])\b[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  );
  const seen = new Set();
  return text
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter((l) => {
      if (!l || l === '-') return false;
      if (l.length < 40 && seen.has(l)) return false; // 반복되는 메뉴 문구 제거
      seen.add(l);
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function textLen(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
}

function limit(s) {
  return s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) + '\n…(이하 생략)' : s;
}

// ---------- 가져오기 ----------

async function get(url, { accept } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8', ...(accept ? { accept } : {}) },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, url: r.url || url, type: r.headers.get('content-type') || '', buf };
  } finally {
    clearTimeout(timer);
  }
}

/** content-type이나 <meta charset>을 보고 EUC-KR 같은 옛 인코딩도 올바르게 읽는다. */
function decodeBody(buf, type) {
  let charset = type.match(/charset=([\w-]+)/i)?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  }
  try {
    return new TextDecoder((charset || 'utf-8').toLowerCase()).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

// 네이버 블로그는 본문이 iframe 안에 있어 모바일 주소로 바꿔 읽는다.
function rewrite(url) {
  const u = new URL(url);
  if (u.hostname === 'blog.naver.com') {
    const m = u.pathname.match(/^\/([^/]+)\/(\d+)/);
    if (m) return `https://m.blog.naver.com/${m[1]}/${m[2]}`;
    const id = u.searchParams.get('blogId');
    const no = u.searchParams.get('logNo');
    if (id && no) return `https://m.blog.naver.com/${id}/${no}`;
  }
  return url;
}

function siteOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\.|^m\./, '');
  } catch {
    return '';
  }
}

// ---------- 유튜브 ----------

function youtubeId(url) {
  const u = new URL(url);
  if (u.hostname === 'youtu.be') return u.pathname.slice(1);
  if (u.searchParams.get('v')) return u.searchParams.get('v');
  return u.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{6,})/)?.[1] || null;
}

let ytdlp = null;
function hasYtDlp() {
  if (ytdlp === null) ytdlp = spawnSync('yt-dlp', ['--version'], { stdio: 'ignore' }).status === 0;
  return ytdlp;
}

function vttToText(vtt) {
  const out = [];
  for (const line of vtt.split('\n')) {
    const l = line.replace(/<[^>]+>/g, '').trim();
    if (!l || l === 'WEBVTT' || /-->/.test(l) || /^(Kind|Language):/.test(l) || /^\d+$/.test(l)) continue;
    if (out[out.length - 1] !== l) out.push(l);
  }
  return out.join(' ');
}

/** yt-dlp가 설치되어 있으면 자막(한국어 우선, 없으면 영어, 자동 생성 포함)을 받아 온다. */
function youtubeTranscript(url) {
  if (!hasYtDlp()) return Promise.resolve('');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-idea-yt-'));
  return new Promise((resolve) => {
    const p = spawn('yt-dlp', [
      '--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'ko.*,ko,en.*,en',
      '--sub-format', 'vtt', '--no-playlist', '-o', path.join(dir, 'v.%(ext)s'), url,
    ], { stdio: 'ignore' });
    const timer = setTimeout(() => p.kill('SIGTERM'), 60000);
    p.on('close', () => {
      clearTimeout(timer);
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.vtt'));
      const pick = files.find((f) => /\.ko/.test(f)) || files[0];
      const text = pick ? vttToText(fs.readFileSync(path.join(dir, pick), 'utf8')) : '';
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(text);
    });
    p.on('error', () => resolve(''));
  });
}

async function readYoutube(url) {
  const id = youtubeId(url);
  const result = { site: 'youtube.com', kind: 'video', title: '', description: '', content: '' };
  try {
    const r = await get(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
    if (r.ok) {
      const j = JSON.parse(r.buf.toString('utf8'));
      result.title = j.title || '';
      result.author = j.author_name || '';
    }
  } catch {}
  // 영상 설명은 시청 페이지 안의 JSON에 들어 있다.
  if (id) {
    try {
      const r = await get(`https://www.youtube.com/watch?v=${id}&hl=ko`);
      const html = r.buf.toString('utf8');
      const m = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
      if (m) result.description = JSON.parse(`"${m[1]}"`);
      if (!result.title) result.title = metaContent(html, ['og:title']);
    } catch {}
  }
  const transcript = await youtubeTranscript(url);
  const parts = [];
  if (result.author) parts.push(`채널: ${result.author}`);
  if (result.description) parts.push(`영상 설명:\n${result.description}`);
  if (transcript) parts.push(`자막:\n${transcript}`);
  else parts.push(hasYtDlp() ? '(자막 없음)' : '(자막은 yt-dlp를 설치하면 가져올 수 있음)');
  result.content = limit(parts.join('\n\n'));
  result.hasTranscript = !!transcript;
  return result;
}

// ---------- X(트위터) ----------

async function readTweet(url) {
  const r = await get(`https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(url)}`);
  if (!r.ok) throw new Error(`X oEmbed ${r.status}`);
  const j = JSON.parse(r.buf.toString('utf8'));
  const text = htmlToText(j.html || '');
  return { site: 'x.com', kind: 'post', title: `${j.author_name || ''}의 게시물`, description: '', content: limit(text) };
}

// ---------- 공개 함수 ----------

export async function fetchLink(url) {
  const base = { url, finalUrl: url, site: siteOf(url), kind: 'page', title: '', description: '', content: '', fetchedAt: new Date().toISOString() };
  try {
    const host = siteOf(url);
    if (/(^|\.)youtube\.com$|^youtu\.be$/.test(host)) return { ...base, ...(await readYoutube(url)) };
    if (/^(x|twitter)\.com$/.test(host)) {
      try {
        return { ...base, ...(await readTweet(url)) };
      } catch {}
    }

    const r = await get(rewrite(url), { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' });
    base.finalUrl = r.url;
    base.site = siteOf(r.url) || base.site;
    if (!r.ok) return { ...base, error: `HTTP ${r.status}` };

    if (r.type.includes('pdf')) return { ...base, kind: 'pdf', error: 'PDF는 본문을 읽지 않음' };
    if (r.type.startsWith('text/plain') || r.type.includes('markdown')) {
      return { ...base, kind: 'text', content: limit(decodeBody(r.buf, r.type)) };
    }
    if (!r.type.includes('html')) return { ...base, kind: 'file', error: `읽을 수 없는 형식 (${r.type || '알 수 없음'})` };

    const html = decodeBody(r.buf, r.type);
    const title = metaContent(html, ['og:title', 'twitter:title']) || clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    const description = metaContent(html, ['og:description', 'twitter:description', 'description']);
    const content = htmlToText(html);
    const loginWall = content.length < 200 && /로그인|log ?in|sign ?in/i.test(content + title);
    return {
      ...base,
      title,
      description,
      content: limit(content),
      ...(loginWall ? { error: '로그인이 필요한 페이지로 보임' } : {}),
    };
  } catch (e) {
    return { ...base, error: e.name === 'AbortError' ? '응답 시간 초과' : e.message };
  }
}

// 첨부와 링크를 AI가 읽을 수 있는 형태로 보조 정보를 만든다.
// 원본은 건드리지 않고, 영상 프레임이나 링크 미리보기를 따로 저장한다.
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const URL_RE = /https?:\/\/[^\s<>"'）)\]]+/g;

export function extractUrls(text) {
  return [...new Set((text || '').match(URL_RE) || [])];
}

export function kindOf(mime = '') {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/')) return 'text';
  return 'file';
}

let ffmpegChecked = null;
export function hasFfmpeg() {
  if (ffmpegChecked === null) {
    const a = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    const b = spawnSync('ffprobe', ['-version'], { stdio: 'ignore' });
    ffmpegChecked = a.status === 0 && b.status === 0;
  }
  return ffmpegChecked;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-500)))));
  });
}

/**
 * 영상에서 대표 프레임 3장을 뽑아 이미지로 저장한다.
 * ffmpeg가 없으면 빈 배열을 돌려주고, 영상은 파일 정보만 AI에 전달된다.
 */
export async function extractVideoFrames(videoPath, outDir, baseName) {
  if (!hasFfmpeg()) return [];
  try {
    const dur = parseFloat(
      await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath]),
    );
    const points = Number.isFinite(dur) && dur > 0 ? [0.1, 0.5, 0.9].map((r) => dur * r) : [0];
    const frames = [];
    for (let i = 0; i < points.length; i++) {
      const name = `${baseName}-frame${i + 1}.jpg`;
      await run('ffmpeg', [
        '-y', '-loglevel', 'error', '-ss', points[i].toFixed(2), '-i', videoPath,
        '-frames:v', '1', '-vf', 'scale=960:-2', path.join(outDir, name),
      ]);
      frames.push(name);
    }
    return frames;
  } catch (e) {
    console.warn('[media] 영상 프레임 추출 실패:', e.message);
    return [];
  }
}

function pickMeta(html, names) {
  for (const n of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`,
      'i',
    );
    const m = html.match(re);
    if (m) return decode(m[1] ?? m[2]);
  }
  return '';
}

function decode(s = '') {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/** 링크의 제목과 설명을 가져온다. 실패해도 링크 원문은 그대로 남는다. */
export async function fetchLinkPreview(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    if (/youtube\.com|youtu\.be/.test(url)) {
      const r = await fetch(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
        { signal: ctrl.signal },
      );
      if (r.ok) {
        const j = await r.json();
        return { url, title: j.title || '', description: j.author_name ? `YouTube · ${j.author_name}` : 'YouTube' };
      }
    }
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (memory-idea link preview)' },
    });
    const type = r.headers.get('content-type') || '';
    if (!type.includes('html')) return { url, title: '', description: type };
    const html = (await r.text()).slice(0, 400_000);
    const title = pickMeta(html, ['og:title', 'twitter:title']) || decode(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]);
    const description = pickMeta(html, ['og:description', 'twitter:description', 'description']);
    return { url, title, description };
  } catch (e) {
    return { url, title: '', description: '', error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

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

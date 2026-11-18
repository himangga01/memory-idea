// 텔레그램 봇 연동. 롱 폴링 방식이라 공개 주소나 HTTPS 없이 집 컴퓨터에서 바로 동작한다.
// - 봇에게 보낸 글, 사진, 영상, 파일, 링크, 전달 메시지를 기록으로 저장
// - 아이데이션이 끝나면 정리 결과를 답장으로 보내줌
// - 그 답장에 다시 답장하면 해당 기록의 "이어서 발전시키기" 대화로 이어짐
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';

const MAX_DOWNLOAD = 20 * 1024 * 1024; // Bot API 다운로드 한도

const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function startTelegram({ token, allowedUsers, apiBase = 'https://api.telegram.org', publicUrl = '', store, createIdea, requestThread, events }) {
  const stateFile = path.join(store.dataDir, 'telegram.json');
  const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { offset: 0, map: {} };
  const saveState = () => {
    const keys = Object.keys(state.map);
    if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete state.map[k];
    fs.writeFileSync(stateFile, JSON.stringify(state));
  };
  const remember = (chatId, messageId, ideaId) => {
    state.map[`${chatId}:${messageId}`] = ideaId;
    saveState();
  };
  const allowed = new Set(allowedUsers.map(String));
  const pollTimeout = Number(process.env.TELEGRAM_POLL_TIMEOUT ?? 50);
  let running = true;

  async function call(method, params = {}) {
    const r = await fetch(`${apiBase}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
    return j.result;
  }

  async function send(chatId, text, { replyTo, html = false } = {}) {
    const chunks = [];
    if (html) chunks.push(text);
    else for (let i = 0; i < text.length; i += 3900) chunks.push(text.slice(i, i + 3900));
    let last = null;
    for (const [i, chunk] of chunks.entries()) {
      last = await call('sendMessage', {
        chat_id: chatId,
        text: chunk,
        ...(html ? { parse_mode: 'HTML' } : {}),
        link_preview_options: { is_disabled: true },
        ...(replyTo && i === 0 ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
      });
    }
    return last;
  }

  // ---------- 파일 받기 ----------

  function fileOf(msg) {
    const out = [];
    if (msg.photo?.length) {
      const p = msg.photo[msg.photo.length - 1];
      out.push({ ...p, mime_type: 'image/jpeg', file_name: `photo-${msg.message_id}.jpg` });
    }
    for (const k of ['video', 'animation', 'video_note', 'document', 'audio', 'voice']) {
      const f = msg[k];
      if (!f) continue;
      const mime = f.mime_type || (k === 'voice' ? 'audio/ogg' : k === 'video_note' ? 'video/mp4' : 'application/octet-stream');
      const ext = { 'audio/ogg': '.ogg', 'video/mp4': '.mp4' }[mime] || '';
      out.push({ ...f, mime_type: mime, file_name: f.file_name || `${k}-${msg.message_id}${ext}` });
    }
    return out;
  }

  async function download(f) {
    if (f.file_size && f.file_size > MAX_DOWNLOAD) throw new Error(`${f.file_name}: 20MB가 넘어 텔레그램 봇으로는 받을 수 없음`);
    const info = await call('getFile', { file_id: f.file_id });
    const r = await fetch(`${apiBase}/file/bot${token}/${info.file_path}`);
    if (!r.ok) throw new Error(`${f.file_name}: 다운로드 실패 (${r.status})`);
    const buf = Buffer.from(await r.arrayBuffer());
    const ext = path.extname(f.file_name || info.file_path || '').slice(0, 10).replace(/[^.\w]/g, '');
    const filename = `${Store.newId()}${ext}`;
    const full = store.uploadPath(filename);
    fs.writeFileSync(full, buf);
    return { filename, path: full, originalname: f.file_name, mimetype: f.mime_type, size: buf.length };
  }

  // ---------- 메시지 처리 ----------

  function forwardedFrom(msg) {
    const o = msg.forward_origin;
    if (!o) return null;
    if (o.type === 'channel') return `${o.chat?.title || '채널'}${o.author_signature ? ` · ${o.author_signature}` : ''}`;
    if (o.type === 'chat') return o.sender_chat?.title || '그룹';
    if (o.type === 'user') return [o.sender_user?.first_name, o.sender_user?.last_name].filter(Boolean).join(' ') || '사용자';
    if (o.type === 'hidden_user') return o.sender_user_name || '사용자';
    return null;
  }

  function sourceLink(msg) {
    const o = msg.forward_origin;
    if (o?.type === 'channel' && o.chat?.username && o.message_id) return `https://t.me/${o.chat.username}/${o.message_id}`;
    return null;
  }

  async function saveMessages(msgs) {
    const first = msgs[0];
    const chatId = first.chat.id;
    const text = msgs.map((m) => m.text ?? m.caption ?? '').find((t) => t) || '';
    const extraUrls = msgs.flatMap((m) => [...(m.entities || []), ...(m.caption_entities || [])])
      .filter((e) => e.type === 'text_link' && e.url)
      .map((e) => e.url);
    const problems = [];
    const files = [];
    for (const f of msgs.flatMap(fileOf)) {
      try {
        files.push(await download(f));
      } catch (e) {
        problems.push(e.message);
      }
    }
    if (!text && !files.length && !extraUrls.length) {
      await send(chatId, problems.length ? `저장하지 못했어요.\n${problems.join('\n')}` : '이 형식은 아직 저장할 수 없어요. 글, 사진, 영상, 파일, 링크를 보내 주세요.', { replyTo: first.message_id });
      return;
    }
    const meta = {};
    const fwd = forwardedFrom(first);
    if (fwd) meta.forwardedFrom = fwd;
    const src = sourceLink(first);
    if (src) meta.sourceUrl = src;

    const idea = await createIdea({
      text,
      files,
      extraUrls,
      meta,
      source: 'telegram',
      origin: { telegram: { chatId, messageId: first.message_id } },
    });
    const note = problems.length ? `\n(일부 첨부는 받지 못했어요: ${problems.join(', ')})` : '';
    const ack = await send(chatId, `기록했어요. 원문 그대로 저장했고, 정리가 끝나면 여기로 보내드릴게요.${note}`, { replyTo: first.message_id });
    remember(chatId, ack.message_id, idea.id);
  }

  const albums = new Map();
  function queueAlbum(msg) {
    const key = `${msg.chat.id}:${msg.media_group_id}`;
    const entry = albums.get(key) || { msgs: [], timer: null };
    entry.msgs.push(msg);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      albums.delete(key);
      saveMessages(entry.msgs.sort((a, b) => a.message_id - b.message_id)).catch((e) => console.error('[telegram]', e));
    }, 1500);
    albums.set(key, entry);
  }

  const HELP = `번뜩 봇입니다.
떠오른 생각, 캡처, 영상, 파일, 링크를 그냥 보내 주세요. 다른 대화방의 메시지를 전달해도 됩니다.
원문 그대로 저장하고, 링크는 본문까지 읽어서 정리한 뒤 분류해 드립니다.

정리 결과 메시지에 답장하면 그 아이디어를 이어서 발전시킬 수 있어요.

/recent 최근 기록 5개
/help 도움말`;

  async function handle(msg) {
    if (!msg?.from || !msg.chat) return;
    const chatId = msg.chat.id;
    if (!allowed.has(String(msg.from.id))) {
      await send(chatId, `이 봇은 등록된 사용자만 쓸 수 있어요.\n내 텔레그램 ID: ${msg.from.id}\n서버의 .env 파일에 TELEGRAM_ALLOWED_USERS=${msg.from.id} 를 넣고 서버를 다시 시작하세요.`);
      return;
    }
    const text = msg.text || '';
    if (/^\/(start|help)\b/.test(text)) return send(chatId, HELP);
    if (/^\/recent\b/.test(text)) {
      const items = store.list().slice(0, 5);
      if (!items.length) return send(chatId, '아직 기록이 없어요.');
      const lines = items.map((i, n) => {
        const title = i.ideation?.title || (i.raw.text || '(첨부 기록)').slice(0, 30);
        const link = publicUrl ? `\n   ${publicUrl}/#/idea/${i.id}` : '';
        return `${n + 1}. [${i.category || '분류 전'}] ${title}${link}`;
      });
      return send(chatId, lines.join('\n'));
    }

    // 정리 결과(또는 저장 확인) 메시지에 글로 답장하면 이어서 대화
    const replyId = msg.reply_to_message?.message_id;
    const ideaId = replyId && state.map[`${chatId}:${replyId}`];
    if (ideaId && text && !msg.photo && !msg.document && !msg.video) {
      const ok = await requestThread(ideaId, text, { telegram: { chatId, messageId: msg.message_id } });
      if (!ok) await send(chatId, '그 기록을 찾지 못했거나 이전 질문에 답하는 중이에요.', { replyTo: msg.message_id });
      else call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      return;
    }

    if (msg.media_group_id) return queueAlbum(msg);
    await saveMessages([msg]);
  }

  // ---------- 결과 알림 ----------

  function formatIdeation(idea) {
    const d = idea.ideation;
    const sections = [];
    sections.push(`<b>${esc(d.title)}</b>\n${esc(idea.category || d.category)}${d.tags.length ? ` · ${d.tags.map((t) => `#${esc(t.replace(/\s+/g, '_'))}`).join(' ')}` : ''}\n\n${esc(d.summary)}`);
    if (d.link_summaries?.length) {
      sections.push(
        '<b>링크 정리</b>\n' +
          d.link_summaries
            .map((l) => `<a href="${esc(l.url)}">${esc(l.title || l.url)}</a>\n${esc(l.summary)}${l.key_points.length ? '\n' + l.key_points.map((k) => `· ${esc(k)}`).join('\n') : ''}`)
            .join('\n\n'),
      );
    }
    if (d.directions.length) sections.push('<b>발전 방향</b>\n' + d.directions.map((x, i) => `${i + 1}. <b>${esc(x.name)}</b> ${esc(x.description)}`).join('\n'));
    if (d.next_steps.length) sections.push('<b>다음 행동</b>\n' + d.next_steps.map((x) => `☐ ${esc(x)}`).join('\n'));
    if (d.questions.length) sections.push('<b>생각해볼 질문</b>\n' + d.questions.map((x) => `· ${esc(x)}`).join('\n'));
    const footer = `<i>이 메시지에 답장하면 이어서 발전시킬 수 있어요.</i>${publicUrl ? `\n<a href="${esc(publicUrl)}/#/idea/${idea.id}">자세히 보기</a>` : ''}`;
    // 텔레그램 한도(4096자)를 넘으면 뒤쪽 섹션부터 뺀다
    while (sections.length > 1 && [...sections, footer].join('\n\n').length > 4000) sections.pop();
    let out = [...sections, footer].join('\n\n');
    if (out.length > 4000) out = `<b>${esc(d.title)}</b>\n\n${esc(d.summary.slice(0, 3000))}\n\n${footer}`;
    return out;
  }

  events.on('ideation:done', async (idea) => {
    const tg = idea.origin?.telegram;
    if (!tg) return;
    try {
      const m = await send(tg.chatId, formatIdeation(idea), { replyTo: tg.messageId, html: true });
      remember(tg.chatId, m.message_id, idea.id);
    } catch (e) {
      console.error('[telegram] 결과 전송 실패:', e.message);
    }
  });

  events.on('ideation:error', async (idea) => {
    const tg = idea.origin?.telegram;
    if (!tg) return;
    await send(tg.chatId, `기록은 저장했지만 아이데이션에 실패했어요.\n${(idea.error || '').slice(0, 500)}`, { replyTo: tg.messageId }).catch(() => {});
  });

  events.on('thread:done', async (idea, message, origin) => {
    const tg = origin?.telegram;
    if (!tg) return;
    try {
      const m = await send(tg.chatId, message.text, { replyTo: tg.messageId });
      remember(tg.chatId, m.message_id, idea.id);
    } catch (e) {
      console.error('[telegram] 답변 전송 실패:', e.message);
    }
  });

  // ---------- 폴링 ----------

  (async () => {
    try {
      const me = await call('getMe');
      console.log(`텔레그램 봇 연결됨: @${me.username}${allowed.size ? '' : ' (TELEGRAM_ALLOWED_USERS가 비어 있어 아무 기록도 받지 않음)'}`);
      await call('setMyCommands', { commands: [{ command: 'recent', description: '최근 기록 5개' }, { command: 'help', description: '도움말' }] }).catch(() => {});
    } catch (e) {
      console.error('텔레그램 연결 실패:', e.message);
    }
    while (running) {
      try {
        const updates = await call('getUpdates', { offset: state.offset, timeout: pollTimeout, allowed_updates: ['message'] });
        for (const u of updates) {
          state.offset = u.update_id + 1;
          saveState();
          await handle(u.message).catch((e) => console.error('[telegram] 처리 실패:', e));
        }
        if (!updates.length && pollTimeout === 0) await sleep(300);
      } catch (e) {
        if (running) {
          console.error('[telegram] 폴링 오류:', e.message);
          await sleep(5000);
        }
      }
    }
  })();

  return { stop: () => (running = false) };
}

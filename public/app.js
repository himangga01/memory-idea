const $ = (s, el = document) => el.querySelector(s);

const state = {
  items: [],
  tags: [],
  q: '',
  tag: '',
  category: '',
  categories: [],
  total: 0,
  files: [],
  detailId: null,
  detail: null,
  pollTimer: null,
};

// ---------- 작은 DOM 도우미 (사용자 글은 항상 textContent로 넣는다) ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    location.reload();
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `오늘 ${t}`;
  return `${d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} ${t}`;
}

const STATUS = { queued: '대기 중', running: '아이데이션 중', done: '', error: '실패' };
const SOURCE = { share: '공유', telegram: '텔레그램' };
const TYPE = { idea: '아이디어', inspiration: '영감', problem: '문제의식', question: '질문', memo: '메모', reference: '자료' };

function linkify(text) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s<>"']+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    frag.append(text.slice(last, m.index));
    frag.append(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  return frag;
}

function mediaThumb(att, { large = false } = {}) {
  const src = `/uploads/${encodeURIComponent(att.file)}`;
  if (att.kind === 'image') return h('a', { href: src, target: '_blank', class: 'thumb' }, h('img', { src, alt: att.originalName, loading: 'lazy' }));
  if (att.kind === 'video') {
    if (large) return h('video', { src, controls: true, preload: 'metadata', class: 'media' });
    const poster = att.frames?.[0] ? `/uploads/${encodeURIComponent(att.frames[0])}` : null;
    return h('a', { href: src, target: '_blank', class: 'thumb video' }, poster ? h('img', { src: poster, alt: '' }) : h('span', {}, '영상'));
  }
  if (att.kind === 'audio' && large) return h('audio', { src, controls: true });
  return h('a', { href: src, target: '_blank', class: 'file-chip' }, att.originalName);
}

// ---------- 피드 ----------

async function loadList() {
  const params = new URLSearchParams();
  if (state.q) params.set('q', state.q);
  if (state.tag) params.set('tag', state.tag);
  if (state.category) params.set('category', state.category);
  const data = await api(`/api/ideas?${params}`);
  state.items = data.items;
  state.tags = data.tags;
  state.categories = data.categories;
  state.total = data.total;
  renderFeed();
  renderCategories();
  renderTags();
  schedulePoll();
}

function renderCategories() {
  const nav = $('#categories');
  if (!state.categories.length) return nav.replaceChildren();
  nav.replaceChildren(
    h('button', { class: `cat${state.category ? '' : ' active'}`, onclick: () => setCategory('') }, '전체', h('small', {}, state.total)),
    ...state.categories.map(([c, n]) =>
      h('button', { class: `cat${state.category === c ? ' active' : ''}`, onclick: () => setCategory(c) }, c, h('small', {}, n)),
    ),
  );
}

function setCategory(c) {
  state.category = c;
  state.tag = '';
  loadList();
}

function renderTags() {
  const nav = $('#tags');
  nav.replaceChildren(
    ...(state.tag ? [h('button', { class: 'tag active', onclick: () => setTag('') }, `#${state.tag} ✕`)] : []),
    ...state.tags
      .filter(([t]) => t !== state.tag)
      .slice(0, 20)
      .map(([t, n]) => h('button', { class: 'tag', onclick: () => setTag(t) }, `#${t}`, h('small', {}, n))),
  );
}

function setTag(t) {
  state.tag = t;
  loadList();
}

function renderFeed() {
  const feed = $('#feed');
  if (!state.items.length) {
    feed.replaceChildren(
      h('div', { class: 'empty' },
        h('p', {}, state.q || state.tag ? '조건에 맞는 기록이 없습니다.' : '아직 기록이 없습니다.'),
        !state.q && !state.tag && h('p', { class: 'hint' }, '떠오른 생각, 캡처한 글, 영상, 링크를 아래에 보내면 원문 그대로 저장하고 AI가 아이디어로 정리합니다.'),
      ),
    );
    return;
  }
  const tpl = $('#tpl-card');
  feed.replaceChildren(
    ...state.items.map((it) => {
      const card = tpl.content.firstElementChild.cloneNode(true);
      card.dataset.id = it.id;
      card.classList.add(`s-${it.status}`);
      $('time', card).textContent = [it.category, fmtTime(it.createdAt), SOURCE[it.source]].filter(Boolean).join(' · ');
      $('.status', card).textContent = STATUS[it.status] || '';
      $('.title', card).textContent = it.title || '';
      $('.raw', card).textContent = it.text;
      $('.thumbs', card).replaceChildren(...it.attachments.map((a) => mediaThumb(a)));
      $('.summary', card).textContent = it.status === 'error' ? `아이데이션 실패: ${(it.error || '').split('\n')[0]}` : it.summary || '';
      $('.chips', card).replaceChildren(...it.tags.map((t) => h('span', { class: 'chip' }, `#${t}`)));
      card.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        location.hash = `#/idea/${it.id}`;
      });
      return card;
    }),
  );
}

// 진행 중인 작업이 있으면 주기적으로 새로 고침
function schedulePoll() {
  clearTimeout(state.pollTimer);
  const pending =
    state.items.some((i) => i.status === 'queued' || i.status === 'running' || i.threadStatus) ||
    (state.detail && (['queued', 'running'].includes(state.detail.status) || state.detail.threadStatus));
  if (!pending) return;
  state.pollTimer = setTimeout(async () => {
    await loadList().catch(() => {});
    if (state.detailId) await loadDetail(state.detailId, { keepScroll: true }).catch(() => {});
  }, 2500);
}

// ---------- 상세 ----------

async function loadDetail(id, { keepScroll = false } = {}) {
  const panel = $('#detail');
  const scroll = panel.scrollTop;
  const draft = $('#thread-input', panel)?.value;
  state.detail = await api(`/api/ideas/${id}`);
  renderDetail();
  if (keepScroll) panel.scrollTop = scroll;
  if (draft) $('#thread-input', panel).value = draft;
  schedulePoll();
}

function section(title, ...body) {
  const content = body.flat().filter(Boolean);
  if (!content.length) return null;
  return h('section', { class: 'block' }, h('h4', {}, title), ...content);
}

function list(items, ordered = false) {
  if (!items?.length) return null;
  return h(ordered ? 'ol' : 'ul', {}, ...items.map((x) => h('li', {}, x)));
}

function renderIdeation(d, idea) {
  if (!d) {
    if (idea.status === 'error') {
      return h('div', { class: 'block error' }, h('h4', {}, '아이데이션 실패'), h('pre', {}, idea.error || ''));
    }
    return h('div', { class: 'block pending' }, h('span', { class: 'spinner' }), STATUS[idea.status] || '대기 중', ' · AI가 원문을 읽고 있습니다');
  }
  const c = d.concept || {};
  const conceptRows = [
    ['문제', c.problem],
    ['대상', c.target],
    ['방법', c.solution],
    ['차별점', c.difference],
  ].filter(([, v]) => v);
  return h('div', { class: 'ideation' },
    h('div', { class: 'ideation-head' },
      h('div', { class: 'labels' },
        h('button', { class: 'category', title: '분류 바꾸기', onclick: () => changeCategory(idea) }, idea.category || d.category, idea.categoryLocked ? ' (직접 지정)' : ''),
        h('span', { class: 'type' }, TYPE[d.type] || d.type),
      ),
      h('h2', {}, d.title),
      h('p', { class: 'lead' }, d.summary),
      h('div', { class: 'chips' }, ...d.tags.map((t) => h('button', { class: 'chip', onclick: () => { location.hash = '#/'; state.category = ''; setTag(t); } }, `#${t}`))),
    ),
    d.link_summaries?.length ? section('링크 정리', ...d.link_summaries.map((l) =>
      h('div', { class: 'link-summary' },
        h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, h('strong', {}, l.title || l.url)),
        h('p', {}, l.summary),
        list(l.key_points),
        l.why_saved && h('p', { class: 'why' }, l.why_saved),
      ))) : null,
    section('이렇게 읽었어요', h('p', {}, d.interpretation)),
    conceptRows.length && section('구체화', h('dl', { class: 'concept' }, ...conceptRows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))),
    section('발전 방향', ...d.directions.map((x) => h('div', { class: 'direction' }, h('strong', {}, x.name), h('p', {}, x.description)))),
    section('생각해볼 질문', list(d.questions)),
    section('다음 행동', d.next_steps.length ? h('ul', { class: 'todo' }, ...d.next_steps.map((x) => h('li', {}, h('label', {}, h('input', { type: 'checkbox' }), ' ', x)))) : null),
    section('연결된 기록', d.connections.length
      ? h('ul', { class: 'links' }, ...d.connections.map((x) => h('li', {}, h('a', { href: `#/idea/${x.id}` }, idea.connectionTitles?.[x.id] || x.id), h('span', {}, ` · ${x.reason}`))))
      : null),
    idea.status === 'queued' || idea.status === 'running'
      ? h('div', { class: 'block pending' }, h('span', { class: 'spinner' }), '다시 아이데이션하는 중')
      : null,
    idea.status === 'error' ? h('div', { class: 'block error' }, h('h4', {}, '다시 아이데이션 실패'), h('pre', {}, idea.error || '')) : null,
  );
}

function renderDetail() {
  const idea = state.detail;
  const panel = $('#detail');
  if (!idea) return;
  const raw = idea.raw;

  const thread = h('div', { class: 'thread' },
    ...idea.thread.map((m) => h('div', { class: `msg ${m.role}${m.error ? ' error' : ''}` }, h('p', {}, m.text), (m.engine || m.via) && h('small', {}, m.via === 'telegram' ? '텔레그램에서' : m.engine))),
    idea.threadStatus && h('div', { class: 'msg ai pending' }, h('span', { class: 'spinner' }), '생각하는 중'),
  );

  const threadForm = h('form', {
    class: 'thread-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const input = $('#thread-input');
      const message = input.value.trim();
      if (!message) return;
      input.value = '';
      try {
        await api(`/api/ideas/${idea.id}/thread`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message, engine: $('#engine').value }),
        });
      } catch (err) {
        input.value = message;
        alert(err.message);
      }
      loadDetail(idea.id, { keepScroll: true });
    },
  },
    h('textarea', { id: 'thread-input', rows: 2, placeholder: '더 물어보기 (예: 제일 작은 버전은?)' }),
    h('button', { type: 'submit', disabled: !!idea.threadStatus }, '보내기'),
  );

  panel.replaceChildren(
    h('div', { class: 'detail-bar' },
      h('button', { class: 'back', onclick: () => (location.hash = '#/') }, '‹ 목록'),
      h('div', { class: 'actions' },
        h('button', {
          disabled: idea.status === 'queued' || idea.status === 'running',
          onclick: async () => {
            await api(`/api/ideas/${idea.id}/ideate`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ engine: $('#engine').value }),
            });
            loadDetail(idea.id, { keepScroll: true });
            loadList();
          },
        }, '다시 아이데이션'),
        h('button', {
          class: 'danger',
          onclick: async () => {
            if (!confirm('이 기록과 첨부 파일을 삭제할까요?')) return;
            await api(`/api/ideas/${idea.id}`, { method: 'DELETE' });
            location.hash = '#/';
            loadList();
          },
        }, '삭제'),
      ),
    ),
    h('div', { class: 'detail-body' },
      h('section', { class: 'original' },
        h('div', { class: 'meta' }, h('span', {}, '원문'), h('time', {}, fmtTime(idea.createdAt))),
        raw.text ? h('div', { class: 'raw-full' }, linkify(raw.text)) : null,
        raw.attachments.length ? h('div', { class: 'media-list' }, ...raw.attachments.map((a) => mediaThumb(a, { large: true }))) : null,
        raw.meta?.forwardedFrom && h('p', { class: 'forwarded' }, `전달된 메시지 · ${raw.meta.forwardedFrom}`, raw.meta.sourceUrl && h('a', { href: raw.meta.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, ' 원본')),
        (idea.links || []).map((l) =>
          h('div', { class: 'link-card' },
            h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, h('strong', {}, l.title || l.url)),
            l.description && h('span', {}, l.description),
            l.content
              ? h('details', {}, h('summary', {}, `가져온 본문 ${l.content.length.toLocaleString()}자${l.hasTranscript ? ' · 자막 포함' : ''}`), h('div', { class: 'fetched' }, l.content))
              : h('span', { class: 'link-error' }, `본문을 가져오지 못했습니다${l.error ? ` (${l.error})` : ''}. 다시 아이데이션하면 재시도합니다.`),
          ),
        ),
      ),
      renderIdeation(idea.ideation, idea),
      idea.engineUsed && h('p', { class: 'engine-note' }, `${idea.engineUsed}로 아이데이션 · 이전 버전 ${idea.ideationHistory.length}개`),
      h('section', { class: 'block' }, h('h4', {}, '이어서 발전시키기'), thread, threadForm),
    ),
  );
  panel.hidden = false;
  document.body.classList.add('has-detail');
}

async function changeCategory(idea) {
  const names = state.categories.map(([c]) => c).join(', ');
  const next = prompt(`새 분류 이름을 입력하세요. 비우면 AI가 정한 분류로 되돌립니다.\n기존 분류: ${names}`, idea.category || '');
  if (next === null) return;
  await api(`/api/ideas/${idea.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ category: next }),
  });
  loadDetail(idea.id, { keepScroll: true });
  loadList();
}

function closeDetail() {
  state.detailId = null;
  state.detail = null;
  $('#detail').hidden = true;
  document.body.classList.remove('has-detail');
}

// ---------- 라우팅 ----------

function route() {
  const m = location.hash.match(/^#\/idea\/([\w-]+)/);
  if (m) {
    state.detailId = m[1];
    $('#detail').scrollTop = 0;
    loadDetail(m[1]).catch((e) => {
      alert(e.message);
      location.hash = '#/';
    });
  } else {
    closeDetail();
  }
}

// ---------- 입력창 ----------

function renderPreviews() {
  const box = $('#previews');
  box.replaceChildren(
    ...state.files.map((f, idx) => {
      const remove = h('button', { type: 'button', class: 'remove', 'aria-label': '첨부 빼기', onclick: () => { state.files.splice(idx, 1); renderPreviews(); } }, '✕');
      if (f.type.startsWith('image/')) {
        const url = URL.createObjectURL(f);
        return h('div', { class: 'preview' }, h('img', { src: url, onload: () => URL.revokeObjectURL(url) }), remove);
      }
      return h('div', { class: 'preview file' }, h('span', {}, f.name), remove);
    }),
  );
  box.hidden = !state.files.length;
}

function addFiles(list) {
  for (const f of list) state.files.push(f);
  renderPreviews();
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

async function submit(e) {
  e.preventDefault();
  const textEl = $('#text');
  const text = textEl.value;
  if (!text.trim() && !state.files.length) return;
  const fd = new FormData();
  fd.append('text', text);
  fd.append('engine', $('#engine').value);
  for (const f of state.files) fd.append('files', f, f.name);
  const btn = $('#send');
  btn.disabled = true;
  try {
    await api('/api/ideas', { method: 'POST', body: fd });
    textEl.value = '';
    autoGrow(textEl);
    state.files = [];
    renderPreviews();
    localStorage.removeItem('draft');
    if (state.detailId) location.hash = '#/';
    await loadList();
    $('#feed').scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    alert(`저장하지 못했습니다: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function checkEngines() {
  const e = await api('/api/engines').catch(() => null);
  if (!e) return;
  const sel = $('#engine');
  for (const opt of sel.options) {
    if (opt.value === 'claude' && !e.claude.available) opt.textContent = 'Claude (없음)';
    if (opt.value === 'codex' && !e.codex.available) opt.textContent = 'Codex (없음)';
  }
  const warn = $('#engine-warning');
  if (!e.claude.available && !e.codex.available && !e.mock) {
    warn.textContent = '서버에서 claude 또는 codex CLI를 찾지 못했습니다. 기록은 저장되지만 아이데이션은 CLI를 설치한 뒤에 실행됩니다.';
    warn.hidden = false;
  } else if (e.mock) {
    warn.textContent = 'MOCK_AI=1 테스트 모드입니다. 실제 AI 대신 고정된 응답을 씁니다.';
    warn.hidden = false;
  }
}

function init() {
  const textEl = $('#text');
  textEl.value = localStorage.getItem('draft') || '';
  autoGrow(textEl);
  textEl.addEventListener('input', () => {
    autoGrow(textEl);
    localStorage.setItem('draft', textEl.value);
  });
  // 데스크톱: Ctrl/Cmd+Enter로 보내기
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
  });
  // 클립보드 이미지(캡처) 붙여넣기
  textEl.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files.map((f, i) => (f.name && f.name !== 'image.png' ? f : new File([f], `capture-${Date.now()}-${i}.png`, { type: f.type }))));
    }
  });
  $('#files').addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });
  // 드래그 앤 드롭
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  });
  $('#composer').addEventListener('submit', submit);

  const engineSel = $('#engine');
  engineSel.value = localStorage.getItem('engine') || 'auto';
  engineSel.addEventListener('change', () => localStorage.setItem('engine', engineSel.value));

  let t;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.q = e.target.value.trim();
      loadList();
    }, 250);
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadList();
  });

  renderPreviews();
  checkEngines();
  loadList();
  route();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();

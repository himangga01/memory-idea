# 번뜩 (memory-idea)

길을 가다 번뜩 떠오른 생각, 좋다고 느낀 글의 캡처, 영상, 링크를 보내면 **원문 그대로 기록**하고, 내 컴퓨터에 설치된 **Claude CLI 또는 Codex CLI**가 자동으로 아이데이션해 주는 개인용 모바일 웹앱(PWA)입니다.

## 하는 일

1. **보내기**: 텍스트, 사진·캡처, 영상, 음성, 텍스트 파일, 링크를 채팅하듯 보냅니다. 휴대폰 홈 화면에 설치하면 안드로이드에서는 다른 앱의 "공유" 메뉴에서 바로 보낼 수 있습니다.
2. **원문 저장**: 입력한 글은 띄어쓰기와 줄바꿈까지 바꾸지 않고, 첨부 파일은 원본 파일 그대로 `data/`에 저장합니다. AI 결과는 원문과 분리해 따로 저장합니다.
3. **자동 아이데이션**: 저장되면 AI가 원문을 읽고 아래 내용을 만듭니다.
   - 제목, 요약, 태그, 유형(아이디어, 영감, 문제의식, 질문, 메모)
   - 원문 해석
   - 구체화: 문제, 대상, 방법, 차별점
   - 서로 다른 발전 방향 3가지
   - 생각해볼 질문, 이번 주에 해볼 작은 행동
   - 예전 기록 중 관련 있는 것과의 연결
4. **이어서 발전시키기**: 기록마다 AI와 대화하며 아이디어를 더 키울 수 있습니다.
5. **다시 아이데이션**: 엔진을 바꿔 다시 돌릴 수 있고, 이전 결과는 지우지 않고 남겨 둡니다.
6. **찾기와 내보내기**: 검색, 태그 필터, 전체 기록 마크다운 내보내기(`/api/export.md`)를 지원합니다.

첨부별 처리 방식:

| 보낸 것 | AI에 전달되는 내용 |
| --- | --- |
| 텍스트 | 원문 그대로 |
| 사진, 캡처 | 이미지 파일 자체 (Claude는 Read 도구로, Codex는 `--image`로 읽음) |
| 영상 | ffmpeg가 있으면 앞·중간·끝 대표 프레임 3장, 없으면 파일 정보만 |
| 링크 | 페이지 제목과 설명. 유튜브는 영상 제목과 채널명 |
| 텍스트 파일 | 파일 내용 |
| 그 밖의 파일 | 파일 이름과 형식만 |

## 구조

```
휴대폰 (PWA) ──HTTP──▶ 내 컴퓨터의 Node 서버 ──▶ claude -p / codex exec
                         └─ data/ideas.json, data/uploads/
```

Claude CLI와 Codex CLI는 내 컴퓨터에 로그인된 계정으로 실행되므로, 서버는 CLI가 설치된 컴퓨터에서 돌려야 합니다. AI 호출은 한 번에 하나씩 대기열로 처리하며, 서버를 껐다 켜도 남은 작업을 이어서 처리합니다.

## 실행

준비물: Node.js 18.17 이상, 그리고 아래 중 하나 이상

- Claude CLI: `npm i -g @anthropic-ai/claude-code` 후 `claude` 실행해 로그인
- Codex CLI: `npm i -g @openai/codex` 후 `codex` 실행해 로그인
- (선택) ffmpeg: 영상에서 프레임을 뽑을 때 사용

```bash
npm install
npm start            # http://localhost:3939
```

AI 없이 화면과 흐름만 보려면 `npm run mock`, 자동 점검은 `npm test`입니다.

## 휴대폰에서 쓰기

PWA 설치와 공유 메뉴 연동은 **HTTPS** 주소에서만 됩니다. 같은 와이파이에서 `http://컴퓨터IP:3939`로 접속하면 기록과 아이데이션은 되지만 홈 화면 설치와 공유 메뉴는 동작하지 않습니다.

밖에서도 쓰려면 HTTPS 터널을 하나 붙이는 방법이 가장 간단합니다.

- **Tailscale** (추천, 내 기기끼리만 접속): 컴퓨터와 휴대폰에 Tailscale을 설치하고 `tailscale serve --bg 3939` 실행. 표시되는 `https://<컴퓨터이름>.<tailnet>.ts.net` 주소로 접속합니다.
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:3939`. 공개 주소가 생기므로 반드시 `ACCESS_TOKEN`을 설정하세요.

접속한 뒤 브라우저 메뉴에서 "홈 화면에 추가"를 누르면 앱처럼 쓸 수 있습니다. 안드로이드는 설치 후 사진, 브라우저, 유튜브 등의 공유 메뉴에 "번뜩"이 나타납니다. iOS는 웹앱 공유 대상 기능을 지원하지 않아서, 앱 안에서 첨부 버튼을 쓰거나 글을 붙여 넣어야 합니다.

## 설정 (환경 변수)

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `PORT` | `3939` | 서버 포트 |
| `HOST` | `0.0.0.0` | 내 컴퓨터에서만 쓰려면 `127.0.0.1` |
| `ACCESS_TOKEN` | 없음 | 설정하면 첫 접속 때 이 값을 입력해야 함. 외부에 열 때는 필수 |
| `DATA_DIR` | `./data` | 기록과 첨부 저장 위치 |
| `DEFAULT_ENGINE` | `auto` | `auto`(Claude 먼저, 실패하면 Codex), `claude`, `codex` |
| `CLAUDE_MODEL` | CLI 기본값 | `claude --model`에 넘길 값 |
| `CODEX_MODEL` | CLI 기본값 | `codex exec --model`에 넘길 값 |
| `CLAUDE_BIN`, `CODEX_BIN` | `claude`, `codex` | CLI 실행 파일 경로 |
| `AI_TIMEOUT_MS` | `300000` | AI 한 번 호출의 제한 시간 |
| `MAX_UPLOAD_MB` | `300` | 첨부 파일 하나의 최대 크기 |
| `MOCK_AI` | 없음 | `1`이면 AI 대신 고정 응답 (테스트용) |

예: `ACCESS_TOKEN=아무도모를문자열 DEFAULT_ENGINE=claude npm start`

화면 오른쪽 위의 선택 상자(자동, Claude, Codex)로 기록마다 엔진을 고를 수도 있습니다.

## AI 호출 방식

- Claude: `claude -p --output-format json --allowedTools Read --add-dir <DATA_DIR>`. 프롬프트는 표준 입력으로 넘기고, 첨부 이미지 경로를 알려 주어 Read 도구로만 열게 합니다.
- Codex: `codex exec --skip-git-repo-check --sandbox read-only --output-last-message <파일> --image=<이미지들> -`. 읽기 전용 샌드박스에서 실행합니다.

프롬프트와 결과 형식은 `lib/ai.js`에 있습니다. 결과 JSON의 항목을 바꾸고 싶으면 `IDEATION_SCHEMA`와 `parseIdeation`, 화면의 `renderIdeation`(`public/app.js`)을 함께 고치면 됩니다.

## 파일 구성

```
server.js            서버, API, 작업 대기열, 공유 받기(/share)
lib/store.js         기록 저장 (data/ideas.json)
lib/ai.js            Claude/Codex CLI 호출, 프롬프트, 결과 파싱
lib/media.js         영상 프레임 추출, 링크 미리보기
public/              PWA 화면 (index.html, app.js, style.css, manifest, sw.js)
scripts/smoke-test.js  MOCK 모드 전체 흐름 점검
```

## 데이터 백업

모든 기록은 `data/` 폴더 하나에 있습니다. 이 폴더를 복사해 두면 백업이 끝나고, 사람이 읽기 좋은 형태가 필요하면 화면 오른쪽 위 내려받기 버튼으로 마크다운 파일을 받을 수 있습니다.

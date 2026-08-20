# 리빙 비세토스 (living-visetos)

관객이 서면 패턴이 태어나고, 그 패턴이 가방이 된다 — 키오스크 체험.
팀 **빽빽한하마** · Vite + TypeScript (프레임워크 无, ADR-001)

## 빠른 시작

```bash
npm install
npm run dev          # http://localhost:5173 → 카메라 허용 → 버튼 0→1→2→3→4
npm run dev          # http://localhost:5173/admin.html → F-09 운영 대시보드
npm run dev          # http://localhost:5173/results/ABCD-1234 → F-06 공개 결과/목업 주문
```

| 명령 | 하는 일 |
| --- | --- |
| `npm run dev` | 개발 서버 |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | 타입체크 + 프로덕션 번들 (`dist/`) |
| `npm run preview` | 빌드 결과 미리보기 |

데모데이 키오스크 실행: `npm run build && npm run preview` 후
`chrome --kiosk --autoplay-policy=no-user-gesture-required http://localhost:4173`

> ✅ ADR-003 이행: 세그멘테이션은 `@mediapipe/tasks-vision` + 로컬 번들로 동작한다.
> wasm 런타임은 `npm install`(postinstall)이 `public/wasm/`으로 복사하고, 모델은
> `public/models/selfie_segmenter.tflite`(커밋됨) — **첫 실행부터 오프라인 가능**.

## 문서

| 문서 | 답하는 질문 |
| --- | --- |
| [`docs/DEV_SETUP.md`](docs/DEV_SETUP.md) | 누가·규칙 (모듈 분담, 브랜치, 통합의 날) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 어떻게 (컴포넌트, 상태머신, ADR, 폴백 매트릭스) |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | 현장에서 어떻게 수습하는가 (단축키, 폴백 영상 준비, 리허설) |
| [`DESIGN.md`](DESIGN.md) | 어떻게 보이는가 (팔레트, 타이포, 컴포넌트) |
| [`docs/skeleton_v0.html`](docs/skeleton_v0.html) | 이 리포가 태어난 v0 걷는 스켈레톤 (히스토리 · 단일 파일로 실행 가능) |

## 구조와 담당

```
src/
├─ contracts.ts   ★ 모듈 간 국경 — 변경은 팀 합의 + PR 리뷰 2인
├─ app/           E 앱 셸·통합    state.ts (상태머신 골격)
├─ vision/        A 비전·캡처     capture.ts / segmenter.ts / seed.ts
├─ pattern/       B 패턴 엔진     l1.ts (프로시저럴) / l2.ts (생성AI 승격 스텁)
├─ render/        C 렌더·연출     overlay.ts (실루엣) / bag.ts (3D 가방)
├─ output/        D 결과물·웹     recorder.ts (녹화·업로드) / qr.ts (QR·짧은 링크)
└─ mocks/         모듈별 목 데이터 — 옆 모듈이 늦어도 내 개발은 멈추지 않는다
public/models/    A: 세그멘테이션 모델 로컬 번들 (예정)
public/assets/    C: 가방 GLTF, 폰트, 사운드
cloud/            D: Vercel Functions + 결과 페이지 (예정)
```

## F-05 결과 전달 카드 (QR / 오프라인 코드)

`deliver()`가 `DeliveryTicket`을 돌려주면 키오스크는 버튼 줄 아래 결과 카드를 띄운다.

- `kind:'url'` → 256px 캔버스 QR + 짧은 링크 + "폰으로 스캔하세요". QR에 넣는 값은 항상
  `new URL(ticket.url, location.origin).href`로 절대화한다. 상대 경로를 그대로 넣으면 폰에서 열리지 않는다.
- `kind:'code'` → QR 없이 세션 코드를 크게 + "나중에 이 코드로 받아가세요" (ARCHITECTURE §9 오프라인 폴백).
- 카드는 `0. 카메라 시작` 또는 `1. 씨앗 추출`을 누르면 사라진다(티켓도 같이 버린다). 앞 관객의 결과가 다음 사람 화면에 남지 않는다.
- QR 라이브러리는 `qrcode`(MIT)를 dependencies로 **로컬 번들**한다. CDN을 타지 않는다 (ADR-003과 같은 오프라인 원칙).
- 개발 확인: `npm run dev` 후 `?mockTicket=url` 또는 `?mockTicket=code`로 카메라 없이 카드를 렌더한다.
  이 주입은 `import.meta.env.DEV` 가드 안에 있어 프로덕션 번들에는 포함되지 않는다.
- 실기기 스캔은 QR이 가리키는 호스트에 폰이 닿을 수 있어야 한다. `localhost`는 폰에서 열리지 않으므로
  LAN 호스트(`vite --host`)나 배포 URL(`RESULT_PUBLIC_BASE_URL`)에서 확인한다.

## F-06 공개 결과와 목업 주문 + F-09 운영 대시보드

`/admin.html`은 키오스크 `index.html`과 분리된 Vite 멀티 페이지 진입점이다. 런타임은
`src/admin/` 아래 정적 DOM + TypeScript만 사용하며 `src/main.ts`, 카메라, 세그멘터,
오버레이, 가방 프리뷰 클래스를 import하지 않는다.

- 공개 결과: F-05 `POST /api/results`가 반환하는 `/results/{code}`는 `result.html`과 `src/result/` 정적 진입점으로 열린다. 로컬 Vite dev와 Vercel 모두 deep link를 `result.html`로 rewrite한다.
- 공개 조회: 방문자 페이지는 운영 토큰 없이 `GET /api/results?code=ABCD-1234`를 호출한다. 이 공개 모드는 `code`, `patternName`, `issuedAt`, `posterUrl`, `videoUrl`, `assetUrlExpiresAt`만 반환하며 서비스 롤 키와 운영 토큰은 노출하지 않는다.
- 목업 주문: 방문자 페이지의 폼은 `POST /api/orders`로 `resultCode`, `visitorName`, `contact`, `productOption`, `consent`를 저장하고 `{ orderId }`만 받는다. 연락처는 이메일 또는 전화번호 형식이어야 하며, 필드 길이와 함수 인스턴스 단위 rate limit이 적용된다.
- 목록: `GET /api/results?limit=20&offset=0`으로 Supabase `results` 테이블의 업로드 완료 기록을 최신순으로 조회한다.
- 상세: 운영 토큰이 있는 `GET /api/results?code=ABCD-1234`는 코드 단건을 조회하고 서버에서 Supabase Storage signed URL과 운영용 `tileMeta`를 발급한다. 같은 코드의 목업 주문은 `GET /api/orders?code=ABCD-1234`로 함께 표시한다.
- 환경: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_RESULTS_BUCKET`, `RESULT_ADMIN_TOKEN`, `RESULT_ASSET_URL_TTL_SECONDS`가 필요하다. F-05 POST URL 응답에는 기존처럼 `RESULT_PUBLIC_BASE_URL`도 필요하다.
- 테이블: Supabase에는 기존 `results` 테이블 외에 `orders` 테이블이 필요하다. 최소 컬럼은 `id`, `result_code`, `visitor_name`, `contact`, `product_option`, `consent`, `created_at`이다.
- 보안: F-09 운영 GET 목록/상세와 `GET /api/orders`는 `Authorization: Bearer <RESULT_ADMIN_TOKEN>`이 필요하다. 키오스크 F-05 POST, 공개 결과 조회, 방문자 F-06 `POST /api/orders`는 같은 토큰을 요구하지 않는다.
- 업로드 방어: F-05 POST는 서버에서 video/poster MIME과 용량을 제한하고, 함수 인스턴스 단위의 기본 rate limit을 둔다. 운영 배포에서는 Vercel/WAF 같은 플랫폼 rate limit도 같이 거는 것을 전제로 한다.
- 한계: F-06 주문은 결제, 제작, 배송, 재고 차감이 없는 데모 기록이다. F-09는 Supabase에 업로드된 기록만 보여준다. 오프라인 IndexedDB 재시도 큐는 이 PR에서 drain하지 않는다. Signed URL은 버킷/오브젝트 권한이 맞아야 열리며, 현재 F-05 녹화본은 전체 최종 가방 합성이 아니라 `overlayCanvas` 기준이다.

## 퍼블리싱 · 운영

### Vercel 배포

키오스크(`index.html`)와 결과 페이지(`result.html`)는 정적 번들, `api/*.ts` 는 Vercel Functions 로 배포된다.
`vercel.json` 이 `/results/:code` → `/result.html` rewrite 를 담당한다.

1. Vercel 프로젝트를 이 리포에 연결한다. Framework Preset = **Vite**, Build Command `npm run build`,
   Output Directory `dist`, Install Command `npm ci`.
2. Node 버전을 **22.x** 로 맞춘다 (`package.json` 의 `engines.node` 가 `>=22.6.0`).
3. 아래 **필수 env 4종**을 Project Settings → Environment Variables 에 넣는다. 하나라도 비면 `api/results.ts`
   와 `api/orders.ts` 가 500 으로 떨어진다.

   | 이름 | 무엇 | 없으면 |
   | --- | --- | --- |
   | `SUPABASE_URL` | Supabase 프로젝트 URL | 결과 저장·조회 전부 실패 |
   | `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용 서비스 롤 키 (**절대 클라이언트 번들에 넣지 않는다**) | 업로드·조회 실패 |
   | `RESULT_ADMIN_TOKEN` | `/admin.html` 운영 조회용 Bearer 토큰 | F-09 대시보드 401 |
   | `RESULT_PUBLIC_BASE_URL` | QR 이 가리킬 공개 베이스 URL (예: `https://<프로젝트>.vercel.app`) | F-05 가 `kind:'url'` 티켓을 못 만든다 → 오프라인 코드 폴백으로 떨어짐 |

   선택 env (기본값 있음 — 안 넣어도 동작한다):

   | 이름 | 기본값 |
   | --- | --- |
   | `SUPABASE_RESULTS_BUCKET` | `results` |
   | `RESULT_ASSET_URL_TTL_SECONDS` | `3600` |
   | `RESULT_UPLOAD_MAX_VIDEO_BYTES` | `26214400` (25 MB) |
   | `RESULT_UPLOAD_MAX_POSTER_BYTES` | `2097152` (2 MB) |

4. Supabase 에 `results` / `orders` 테이블과 결과 버킷이 있어야 한다 (컬럼은 위 F-06·F-09 절 참고).
5. 배포 후 확인: `/` 키오스크 로드 → `/results/ABCD-1234` 가 `result.html` 로 열리는지 → `/admin.html` 이
   토큰 없이 401 을 주는지.

### 키오스크 실행

데모데이 현장은 **로컬 프리뷰**로 돌린다. 네트워크가 끊겨도 체험 자체는 계속돼야 하기 때문이다
(폴백 매트릭스 1행).

```bash
npm ci && npm run build && npm run preview      # http://localhost:4173
chrome --kiosk --autoplay-policy=no-user-gesture-required http://localhost:4173
```

- macOS 라면 `open -a "Google Chrome" --args --kiosk --autoplay-policy=no-user-gesture-required http://localhost:4173`.
- 카메라 권한은 **행사 시작 전에 미리 한 번 허용**해 둔다. 키오스크 모드에서는 권한 프롬프트를 놓치기 쉽다.
- QR 을 폰으로 스캔하려면 `localhost` 로는 안 된다. LAN 호스트(`npm run preview -- --host`)나
  배포 URL(`RESULT_PUBLIC_BASE_URL`)을 쓴다.
- 키오스크 종료는 `Cmd/Alt + F4`. 브라우저 UI 가 없으므로 운영 노트북에 터미널을 하나 열어둔다.

### 운영 단축키

무인 키오스크는 고장 났을 때 **운영자가 손으로 되살릴 수 있어야** 한다. 무대 모드(`/`, `?debug=1` 없이)에는
화면에 드러나지 않는 단축키 세 개가 걸려 있다. 자세한 절차는 [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

| 키 | 하는 일 |
| --- | --- |
| `Shift+D` | 목 카메라 **데모 모드** 토글 — 웹캠이 죽어도 여정을 그대로 완주한다 (§9 '카메라 실패' 행) |
| `Shift+R` | **강제 RESET** — 어떤 상태에서든 세션을 파기하고 처음 화면으로 |
| `Shift+F` | **전체 장애 폴백 화면** 토글 — `public/assets/fallback.mp4` 재생 (§9 '전체 장애' 행) |

- 단축키 목록은 **화면 어디에도 그리지 않는다.** 유일한 예외는 카메라 실패 화면(ERROR_RECOVER)의
  `운영자 · Shift+D — 데모 모드로 계속` 한 줄이다. 그 화면에서만 필요한 탈출구이기 때문이다.
- 데모 모드가 켜지면 무대에 `데모 모드 · 목 카메라` 표기가 작게 뜬다 — 관객을 속이지 않는다.
- 키는 `event.code` 로 읽는다(한글 IME 에서 `event.key` 는 `ㅇ`·`ㄱ` 이 되어 단축키가 죽는다).
  관객이 이름을 입력하는 동안에는 `Shift+D`·`Shift+F` 가 잠긴다. `Shift+R` 만 예외다 —
  그 화면에서 데모 모드·폴백이 필요하면 `Shift+R` 로 먼저 빠져나온 뒤 누른다.
- `?debug=1` 계기판에서는 단축키를 걸지 않는다. 대신 F-07 드랍·F-08 멤버십·F-09 대시보드로 가는
  링크 줄이 상태 표시 아래에 뜬다(무대 모드에는 아예 만들어지지 않는다). 같은 링크가 `/admin.html` 헤더에도 있다.
- **`public/assets/fallback.mp4` 는 리포에 없다** (`.gitignore` 의 `*.mp4`). 없으면 `Shift+F` 가
  '폴백 영상 준비 필요' 플레이스홀더를 띄운다. 만드는 방법은 `docs/OPERATIONS.md` §2.
- 폴백 리허설(개발 서버 전용): `?failCamera=1` 로 `getUserMedia` 를 거절시켜 CREATE → ERROR_RECOVER 를
  카메라를 가리지 않고 재현한다. `?mockCamera=1` 은 카메라 없이 여정을 완주한다.

### 폴백 매트릭스 요약

전체 표와 감지 조건은 [`docs/ARCHITECTURE.md` §9](docs/ARCHITECTURE.md) 에 있다. 운영자가 외워야 할 다섯 줄:

| 상황 | 동작 | 관객이 보는 것 |
| --- | --- | --- |
| 인터넷 없음 | 재시도 큐 + 세션 코드 발급 | 정상 체험, "코드로 받아가세요" |
| 생성AI 장애 (L2 타임아웃) | L1 패턴 유지 | 차이 모름 |
| 카메라 실패 | 목 마스크·목 시드 데모 모드 | 운영자 안내 후 시연 계속 |
| 조명 열악 | 대비 보정 + 오버레이 불투명도 조정 | 품질 저하만 |
| 전체 장애 | 사전 녹화 영상 재생 (운영 단축키) | 데모 영상 |

### 에셋

`public/assets/` 의 출처·라이선스는 [`public/assets/README.md`](public/assets/README.md) 에 적는다.
`bag.glb` 는 현재 **출처 미확인** 상태이므로 외부 공개 배포 전에 C 담당 확인이 필요하다.

### CI

`.github/workflows/ci.yml` 이 모든 push 와 PR 에서 `npm ci → typecheck → test → build` 를 Node 22.x 로 돌린다.
로컬에서 같은 것을 돌리려면 `npm run typecheck && npm test && npm run build`.

**계약이 국경이다.** 모듈은 `src/contracts.ts`의 타입으로만 대화한다. 구현은 자유.
계약 v1의 출처는 `docs/ARCHITECTURE.md` §5 (DEV_SETUP §3의 초안을 대체).

## v0 → v0.1 에서 이미 한 것 / 남은 것

이 커밋은 W1 체크리스트 1번(**리포 생성 + 구조 커밋**)이다. 스켈레톤의 4개 함수를
계약 경계 뒤로 이식했고, 동작은 v0과 동일하다.

| 모듈 | 남은 W1 과제 (ARCHITECTURE §11) |
| --- | --- |
| A | classic CDN → tasks-vision + 로컬 모델 (ADR-003), 마스크 품질 스파이크 |
| B | 문법 파라미터 5개 정의, Grammar Guard 분리, L2 실제 연결 (`l2.ts`는 항상 null) |
| C | 2D 합성 → three.js 씬 오버레이 플레인 (ADR-004), 가방 GLTF 소싱 |
| D | MediaRecorder 검증 → `recorder.ts` 구현 (지금은 throw) |
| E | 버튼 플로우를 StateMachine 아래로, EventBus, 키오스크 화면 |

## 협업 규칙 (DEV_SETUP §5)

- `main`은 항상 데모 가능. 깨진 채로 24시간을 넘기지 않는다.
- `feat/모듈-기능` 브랜치 → PR. 리뷰 1인, `contracts.ts` 변경만 2인.
- 이슈는 기능 ID로 (`F-02 L1 밀도 파라미터화`), 라벨 = 모듈명.
- 주 1회 통합의 날 — 통합 부채 이월 금지.

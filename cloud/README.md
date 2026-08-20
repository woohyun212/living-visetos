# cloud — 결과물 배달 구역 (D + E)

키오스크가 아니라 **관객 폰 때문에** 존재하는 구역이다. QR로 열 결과 페이지는 인터넷에 있어야 하므로.
(ARCHITECTURE §2 / ADR-006)

- Result API: Vercel Functions
- 스토리지·DB: Supabase (ADR-006은 D 담당 취향에 따라 Firebase로 수정 가능)
- 결과 페이지: 정적 호스팅
- 목업 주문: Supabase REST `orders` 테이블에 저장하는 데모 전용 기록

## Vercel 배포 절차

정적 번들과 `api/` 함수를 한 프로젝트로 배포한다. 저장소 루트가 프로젝트 루트다.

1. `vercel link` — 기존 프로젝트에 연결하거나 새로 만든다. Framework Preset은 Vite,
   Build Command는 `npm run build`, Output Directory는 `dist`다 (`package.json`의 `build`는
   `tsc && vite build`).
2. `vercel env add <NAME> production` (그리고 필요하면 `preview`) 로 아래 환경변수를 넣는다.
   `SUPABASE_SERVICE_ROLE_KEY`와 `RESULT_ADMIN_TOKEN`은 절대 `VITE_` 접두사를 붙이지 않는다 —
   붙이면 클라이언트 번들에 인라인된다.
   - 필수: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESULT_PUBLIC_BASE_URL`, `RESULT_ADMIN_TOKEN`
   - 선택: `SUPABASE_RESULTS_BUCKET`, `RESULT_ASSET_URL_TTL_SECONDS`,
     `RESULT_UPLOAD_MAX_VIDEO_BYTES`, `RESULT_UPLOAD_MAX_POSTER_BYTES`,
     `RESULT_UPLOAD_RATE_LIMIT`, `RESULT_PUBLIC_RATE_LIMIT`, `RESULT_UNAUTH_RATE_LIMIT`,
     `RESULT_ADMIN_RATE_LIMIT`, `ORDER_RATE_LIMIT`
3. `vercel build` 로 로컬 산출물(`.vercel/output`)을 만들어 함수가 잡히는지 확인하고,
   `vercel deploy --prebuilt` 또는 `vercel --prod` 로 배포한다.
4. 배포 후 `RESULT_PUBLIC_BASE_URL`을 실제 배포 도메인으로 맞춘다. 이 값이 틀리면
   업로드 응답의 QR 링크가 다른 도메인을 가리킨다.
5. `vercel.json`의 rewrite가 `/results/:code` → `/result.html`을 담당한다. 로컬 dev 서버는
   `vite.config.ts`의 미들웨어가 같은 rewrite를 제공한다.

### 함수 시그니처 규약

Vercel Node 런타임이 `api/`에서 인정하는 형태는 세 가지다 (공식 문서 기준):

- **Web Handler — 메서드별 named export**: `export function GET(request: Request)` /
  `export function POST(request: Request)`
  ([Functions API Reference § Function signature](https://vercel.com/docs/functions/functions-api-reference#function-signature))
- **`fetch` Web Standard export**: `export default { fetch(request: Request) {...} }`
  ([Functions API Reference § fetch Web Standard](https://vercel.com/docs/functions/functions-api-reference#fetch-web-standard),
  [Node.js 런타임 § Create a Node.js function in /api](https://vercel.com/docs/functions/runtimes/node-js))
- **Node `(request, response)` 핸들러**: `export default (request, response) => {...}`
  ([Node.js 런타임 § Node.js request and response objects](https://vercel.com/docs/functions/runtimes/node-js))

`api/results.ts`와 `api/orders.ts`는 이 중 **Web Handler named export(`GET`/`POST`)** 를
배포 진입점으로 노출하고, 동시에 `Request` 1-인자 호출과 Node `(req, res)` 호출을 모두 받는
callable `default` export를 유지한다. `default`가 필요한 이유는 `vite.config.ts`의 로컬
미들웨어가 `api.default(webRequest)`로 직접 호출하기 때문이고, 어느 형태가 선택되든 세 경로 모두
같은 `handleRequest(request: Request)`로 수렴하므로 동작이 갈라지지 않는다.

> 이 저장소에는 Vercel 계정과 CLI가 없어 `vercel build` 산출물 검증은 하지 못했다.
> 위 규약은 공식 문서 근거이며, 실배포 전에 `vercel build` 한 번으로 함수 인식 여부를 확인할 것.

## F-05 Result API

Vercel Functions는 루트 `api/` 폴더를 함수로 배포하므로 실제 업로드 엔드포인트는
`api/results.ts`에 둔다. 키오스크의 `deliver()`는 `/api/results` 업로드를 먼저 시도하고,
실패하면 IndexedDB 재시도 큐 + 세션 코드로 폴백한다.

필요한 환경변수:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_RESULTS_BUCKET` (기본값: `results`)
- `RESULT_PUBLIC_BASE_URL` (예: `https://living-visetos.vercel.app`)
- `RESULT_ADMIN_TOKEN` (F-09 GET 관리자 조회용 bearer token)
- `RESULT_ASSET_URL_TTL_SECONDS` (F-09 signed URL 만료, 기본값: `3600`)
- `RESULT_UPLOAD_MAX_VIDEO_BYTES` (F-05 업로드 video 최대 크기, 기본값: `26214400`)
- `RESULT_UPLOAD_MAX_POSTER_BYTES` (F-05 업로드 poster 최대 크기, 기본값: `2097152`)
- `RESULT_UPLOAD_RATE_LIMIT` (키오스크 업로드 버킷, 분당 IP 당, 기본값: `10`)
- `RESULT_PUBLIC_RATE_LIMIT` (관객 공개 조회 버킷, 분당 IP 당, 기본값: `240`)
- `RESULT_UNAUTH_RATE_LIMIT` (토큰 없는/틀린 운영 경로 요청 버킷, 분당 IP 당, 기본값: `30`)
- `RESULT_ADMIN_RATE_LIMIT` (인증된 운영 버킷, 분당 토큰 당, 기본값: `120`)
- `ORDER_RATE_LIMIT` (F-06 목업 주문 POST 버킷, 분당 IP 당, 기본값: `12`)

### 결과 코드 발급과 덮어쓰기 차단

`POST /api/results`는 무인증 엔드포인트라 클라이언트가 코드를 고르면 남의 결과를 덮어쓸 수 있다.
그래서 코드 소유권을 서버가 판정한다.

- `code` 폼 필드를 **생략하면 서버가 발급한다.** 응답은 `{ url, code }`이고 `code`는
  `XXXX-XXXX`(base36 8자) 모양으로 `recorder.ts`의 `createSessionCode()`와 같다.
- `code`를 보내면 하위호환으로 받아주되, 이미 존재하는 코드면 **어떤 쓰기도 하기 전에 409**
  `{"error":"Result code already exists."}`로 거절한다.
- 사전 확인과 실제 쓰기 사이의 경합은 Storage(`x-upsert` 없는 POST)와 `results.code` unique
  제약이 닫는다. 두 upstream 409 모두 HTTP 409로 매핑된다.

> 클라이언트 영향: `recorder.ts`의 `deliver()`는 응답의 `url`만 읽으므로 기존 계약 그대로 동작한다.
> 다만 409를 받으면 업로드 실패로 간주해 **같은 코드로** IndexedDB 재시도 큐에 넣는다 —
> 그 코드는 영구히 409이므로 재시도가 성공하지 못한다. 큐 drain 로직이 붙을 때
> `code`를 빼고 재전송(서버 발급)하도록 맞춰야 한다.

Supabase에는 `results` 버킷과 `results` 테이블이 필요하다. 테이블은 최소한
`code`, `session_id`, `pattern_name`, `issued_at`, `tile_meta`, `video_path`,
`poster_path` 컬럼을 가진다. `code`는 결과 URL과 Storage object prefix의 기준이므로
unique 제약을 둔다.

## F-06 Public Result + Mock Order

공개 결과 페이지는 `/results/{code}`에서 열린다. Vite 로컬 dev 서버는 `/results/*`를
`result.html`로 rewrite하고, Vercel 배포는 `vercel.json` rewrite로 같은 경로를 제공한다.

공개 GET 엔드포인트:

- `GET /api/results?code=ABCD-1234` — 운영 토큰이 없고 `code`가 있을 때 공개 상세 모드로 동작한다. 응답은 `code`, `patternName`, `issuedAt`, `posterUrl`, `videoUrl`, `assetUrlExpiresAt`만 포함한다.

목업 주문 엔드포인트:

- `POST /api/results` — F-05 업로드. `sessionId`, `certificate`, `video`, `posterImage` 필수이고 `code`는 선택이다. 성공 시 `{ url, code }`를 반환하고, 이미 있는 코드면 409다.
- `POST /api/orders` — 방문자 폼에서 `resultCode`, `visitorName`, `contact`, `productOption`, `consent` JSON을 받는다. 성공 시 `{ orderId }`를 반환한다.
- `GET /api/orders?code=ABCD-1234` — F-09 운영 화면에서 같은 결과 코드의 목업 주문을 조회한다. `Authorization: Bearer <RESULT_ADMIN_TOKEN>`이 필요하다.

`orders` 테이블 최소 컬럼:

| 컬럼 | 역할 |
| --- | --- |
| `id` | 주문 ID. UUID/text 등 Supabase에서 기본 생성되도록 둔다. |
| `result_code` | 정규화된 결과 코드. |
| `visitor_name` | 방문자 이름 또는 닉네임, 최대 40자. |
| `contact` | 이메일 또는 전화번호, 최대 80자. |
| `product_option` | `classic-tote`, `mini-tote`, `flat-pouch` 중 하나. |
| `consent` | 목업 주문 기록 저장 동의 여부. |
| `created_at` | 서버 함수에서 기록한 ISO 시각. |

F-06 제한:

- 목업 주문은 결제, 제작, 배송, 송장, 재고 차감이 없는 데모 데이터다.
- `POST /api/orders`는 운영 토큰을 요구하지 않으므로 함수 인스턴스 단위 rate limit, 필수 필드, 코드 정규화, 길이 제한, 연락처 형식 검사를 적용한다. 운영 배포에서는 플랫폼/WAF rate limit을 추가로 적용한다.
- 공개 결과 조회는 서비스 롤 키와 `RESULT_ADMIN_TOKEN`을 브라우저에 노출하지 않는다.

## F-09 Operations Dashboard MVP

관리 화면은 `/admin.html`에서 열린다. 키오스크 번들과 독립된 `src/admin/` 코드만 실행하며,
카메라·세그멘터·오버레이·가방 프리뷰 런타임을 만들지 않는다.

GET 엔드포인트:

- `GET /api/results?limit=20&offset=0` — Supabase REST `select`/`order`/`limit`/`offset`으로 최신 결과 목록을 반환한다.
- `GET /api/results?code=ABCD-1234` — 운영 토큰이 있으면 POST와 같은 코드 정규화 후 운영용 단건 상세를 반환한다.
- `GET /api/orders?code=ABCD-1234` — 같은 결과 코드로 저장된 F-06 목업 주문 목록을 반환한다.

F-09 환경과 보안:

- `SUPABASE_SERVICE_ROLE_KEY`는 Vercel Function 내부에서만 사용하고 클라이언트로 내려보내지 않는다.
- F-09 운영 GET은 `Authorization: Bearer <RESULT_ADMIN_TOKEN>`이 필요하다. 운영자는 `/admin.html`의 운영 토큰 필드에 매번 값을 입력하며, 토큰은 브라우저 저장소에 보관하지 않는다.
- F-05 `POST /api/results`는 현장 키오스크 업로드 계약을 유지하기 위해 `RESULT_ADMIN_TOKEN`을 요구하지 않는다.
- F-05 POST는 `video/mp4`, `video/webm`, `image/png`, `image/jpeg`만 받고 video/poster 용량을 제한한다.
- rate limit 버킷은 넷으로 갈라져 있다: **업로드**(키오스크) · **공개 조회**(관객 폰) ·
  **미인증**(토큰 없는/틀린 운영 경로 요청) · **운영**(인증 성공). 앞의 셋은 IP 키,
  운영 버킷만 제시된 토큰 키다. 전시장은 단일 NAT라 관객 폰이 전부 같은 IP로 보이므로,
  IP 키 운영 버킷이면 관객 트래픽만으로 운영자가 429에 잠긴다.
- 인증 검사는 rate limit보다 **먼저** 돈다. 순서가 반대면 토큰 없는 요청이 운영 버킷을
  소모해 같은 잠김이 재현된다. 미인증 요청은 401을 받되 미인증 버킷을 소진하면 429가 된다.
- 함수 인스턴스 단위 카운터이므로 운영 배포에서는 Vercel/WAF 같은 플랫폼 rate limit을 추가로 적용한다.
- 무인증 경로(`POST /api/results`, `POST /api/orders`, 공개 `GET /api/results?code=`)의 실패 응답은
  Supabase 응답 본문을 싣지 않는다. 상세는 서버 로그(`[api/results]`, `[api/orders]`)에만 남고,
  운영 토큰으로 인증된 조회에만 그대로 노출된다.
- `api/results.ts`, `api/orders.ts`는 Vercel용 Web Handler named export(`GET`/`POST`)와,
  Vite 로컬 미들웨어의 Web `Request` 및 Vercel Node `req/res` 호출을 모두 처리하는
  callable default handler를 함께 노출한다. 자세한 근거는 위 「함수 시그니처 규약」 참고.
- 상세 응답의 `videoUrl`, `posterUrl`은 서버가 Supabase Storage REST
  `POST /storage/v1/object/sign/{bucket}/{path}`로 발급한 signed URL이다.
- `RESULT_ASSET_URL_TTL_SECONDS`가 없으면 signed URL TTL은 3600초다.
- `RESULT_PUBLIC_BASE_URL`은 F-05 `POST /api/results`의 기존 `{ url }` 응답에 필요하며, GET에는 필요하지 않다.

F-09 한계:

- 대시보드는 Supabase에 업로드된 records만 표시한다.
- 키오스크가 오프라인으로 IndexedDB/localStorage에 큐잉한 결과는 이 PR에서 drain하지 않는다.
- Signed asset URL은 Supabase 버킷과 오브젝트 권한이 허용되어야 열릴 수 있다.
- 현재 F-05 녹화본은 전체 최종 가방 합성이 아니라 `overlayCanvas`를 기록한다.

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

## 자체 서버 호스팅 (Vercel 대안)

Vercel 대신 사용자 소유 단일 VM 에 올리는 경로다. Vercel 배포와 **같은 `api/*.ts` 핸들러를
그대로** 쓰고, 앞단만 `server.mjs`(Node 내장 `http`)로 바꾼다.

### 구조

```
/opt/living-visetos/
  server.mjs      # 정적 서빙 + /results 리라이트 + /api/* 위임
  api/*.ts        # Vercel 과 동일한 소스. node --experimental-transform-types 로 직접 로드
  dist/           # vite build 산출물
  package.json
/etc/living-visetos.env          # 비밀값 (600, root:root)
/etc/systemd/system/living-visetos.service
```

`server.mjs` 는 Node 내장 모듈만 사용하고 `api/*.ts` 도 런타임 npm 의존성이 없다
(Supabase 접근은 전부 `fetch`). 따라서 **서버에 `node_modules` 를 두지 않는다.**
리포가 private 이라 서버에서 `git clone` 하지 않고, 빌드 산출물만 rsync 로 밀어 넣는다.

`server.mjs` 의 요청 어댑터는 `vite.config.ts` 로컬 미들웨어의 `toWebRequest` /
`sendWebResponse` 를 이식한 것이다. 다만 업로드 본문은 `duplex: 'half'` 스트리밍 대신
버퍼링하고, 버퍼를 붙일 때 `content-length` / `transfer-encoding` 을 제거한다
(undici 가 프레이밍 헤더를 다시 계산하므로 남겨두면 `formData()` 가 깨진다).

`/results` 리라이트 범위는 `vercel.json`(`/results/:code`)이 아니라 vite 쪽
(`/results` 와 `/results/*` 모두)을 따른다.

### 최초 서버 준비

```bash
# 1. Node 22.x (>=22.7 이어야 --experimental-transform-types 가 있다)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# 2. 전용 비권한 계정
useradd --system --no-create-home --shell /usr/sbin/nologin living-visetos

# 3. 비밀값. RESULT_ADMIN_TOKEN 은 반드시 새로 생성한다(테스트 토큰 재사용 금지).
openssl rand -hex 32 > /root/living-visetos.admin-token
chmod 600 /root/living-visetos.admin-token
cat > /etc/living-visetos.env <<'ENV'
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
RESULT_PUBLIC_BASE_URL=http://<공인주소>[:포트]
RESULT_ADMIN_TOKEN=<위에서 생성한 값>
PORT=443
ENV
chmod 600 /etc/living-visetos.env
```

> `EnvironmentFile` 은 `export` 접두사를 이름의 일부로 파싱한다. `.omc/e2e.env` 처럼
> `export KEY=VALUE` 형태를 그대로 복사하면 **모든 변수가 비어서 API 가 조용히 503** 을
> 낸다(핸들러가 모듈 로드 시점에 `process.env` 를 읽기 때문). 반드시 `export ` 를 제거한다.

systemd 유닛은 비특권 계정으로 1024 미만 포트를 열기 위해
`AmbientCapabilities=CAP_NET_BIND_SERVICE` 를 쓴다.

### TS 로딩 플래그는 반드시 `--experimental-transform-types` 다

`--experimental-strip-types`(스트립 전용)로는 **기동하지 않는다.** `api/*.ts` 의 `HttpError` 가
생성자 파라미터 프로퍼티를 쓰는데, 이건 타입을 지우는 것만으로는 처리할 수 없는 문법이라
스트립 전용 모드가 거부한다:

```
TypeScript parameter property is not supported in strip-only mode
```

`--experimental-transform-types` 는 스트립 전용의 상위 집합이라 파라미터 프로퍼티·enum·
namespace 까지 처리한다. api 코드가 파라미터 프로퍼티를 계속 쓰는 한 이 플래그를 유지한다.
(w4 통합 브랜치에서 `readonly detail?` 이 추가되며 파라미터 프로퍼티가 2 개로 늘었다 —
스트립 전용을 고집했다면 그 머지 시점에 서비스가 부팅 실패했을 것이다.)

### 배포

```bash
scripts/deploy.sh <ssh-target>          # 빌드 -> rsync -> 서비스 재시작
DEPLOY_HOST=living-visetos scripts/deploy.sh
SKIP_BUILD=1 scripts/deploy.sh <ssh-target>   # 이미 빌드한 dist/ 재전송
```

`DEPLOY_PATH`(기본 `/opt/living-visetos`), `DEPLOY_SERVICE`(기본 `living-visetos`)로
경로와 유닛 이름을 바꿀 수 있다. 호스트는 하드코딩하지 않는다.

### 포트 선택 주의 (NAT 환경)

서버가 공유기/NAT 뒤에 있으면 리스닝 포트와 **외부에서 실제로 열리는 포트가 다르다.**
`ss -tulpn` 으로 로컬만 확인하면 안 되고, 외부에서 반드시 검증한다. 포워딩되지 않은
포트를 고르면 서비스는 정상인데 관객 폰에서만 안 열린다.

`RESULT_PUBLIC_BASE_URL` 은 QR 로 찍히는 결과 URL 의 기준이므로 **외부에서 접근 가능한
주소와 포트**를 그대로 적어야 한다. 기본 포트가 아니면 `http://1.2.3.4:443` 처럼 포트까지 넣는다.

### 한계

- TLS 가 없다. 도메인이 없어 인증서를 발급받지 못하므로 평문 HTTP 로 서비스한다.
  도메인이 생기면 앞단에 nginx + Let's Encrypt 를 두고 `server.mjs` 는 localhost 포트로
  내리는 구성이 맞다.
- rate limit 은 프로세스 단위이며 `x-forwarded-for` 가 없는 직결 환경에서는
  클라이언트 구분이 되지 않는다. 아래 "운영 주의" 참고.

### 운영 주의 — rate limit 이 사실상 전역이다

`api/results.ts` / `api/orders.ts` 의 `clientAddressFor()` 는 `x-forwarded-for` 나
`x-real-ip` 가 없으면 문자열 `'unknown'` 으로 떨어진다. 리버스 프록시 없이 직결로
받는 자체 서버에서는 두 헤더가 **항상 없으므로 모든 클라이언트가 같은 버킷**을 쓴다.

게다가 Vercel 처럼 인스턴스가 자주 갈리지 않고 프로세스가 계속 살아 있어서
버킷이 프로세스 수명 내내 누적된다. 결과적으로:

- `UPLOAD_RATE_LIMIT = 10` → 설치 전체에서 분당 업로드 10 건
- `ORDER_RATE_LIMIT = 12` → 설치 전체에서 분당 주문 12 건

키오스크 1 대 현장 운영에는 충분하지만, 동시 다발 트래픽이나 부하 테스트에서는
정상 요청이 429 로 막힌다. 앞단에 nginx 를 두게 되면 `x-forwarded-for` 를 넣어 주고,
그 전까지는 이 한계를 감안해서 운영한다.

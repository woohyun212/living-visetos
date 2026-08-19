# cloud — 결과물 배달 구역 (D + E)

키오스크가 아니라 **관객 폰 때문에** 존재하는 구역이다. QR로 열 결과 페이지는 인터넷에 있어야 하므로.
(ARCHITECTURE §2 / ADR-006)

- Result API: Vercel Functions
- 스토리지·DB: Supabase (ADR-006은 D 담당 취향에 따라 Firebase로 수정 가능)
- 결과 페이지: 정적 호스팅

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

Supabase에는 `results` 버킷과 `results` 테이블이 필요하다. 테이블은 최소한
`code`, `session_id`, `pattern_name`, `issued_at`, `tile_meta`, `video_path`,
`poster_path` 컬럼을 가진다.

## F-09 Operations Dashboard MVP

관리 화면은 `/admin.html`에서 열린다. 키오스크 번들과 독립된 `src/admin/` 코드만 실행하며,
카메라·세그멘터·오버레이·가방 프리뷰 런타임을 만들지 않는다.

GET 엔드포인트:

- `GET /api/results?limit=20&offset=0` — Supabase REST `select`/`order`/`limit`/`offset`으로 최신 결과 목록을 반환한다.
- `GET /api/results?code=ABCD-1234` — POST와 같은 코드 정규화 후 단건 상세를 반환한다.

F-09 환경과 보안:

- `SUPABASE_SERVICE_ROLE_KEY`는 Vercel Function 내부에서만 사용하고 클라이언트로 내려보내지 않는다.
- F-09 GET은 `Authorization: Bearer <RESULT_ADMIN_TOKEN>`이 필요하다. 운영자는 `/admin.html`의 운영 토큰 필드에 값을 입력하며, 토큰은 브라우저 `sessionStorage`에만 보관된다.
- F-05 `POST /api/results`는 현장 키오스크 업로드 계약을 유지하기 위해 `RESULT_ADMIN_TOKEN`을 요구하지 않는다.
- F-05 POST는 `video/mp4`, `video/webm`, `image/png`, `image/jpeg`만 받고 video/poster 용량을 제한한다.
- API에는 함수 인스턴스 단위의 기본 rate limit이 있으며, 운영 배포에서는 Vercel/WAF 같은 플랫폼 rate limit을 추가로 적용한다.
- 상세 응답의 `videoUrl`, `posterUrl`은 서버가 Supabase Storage REST
  `POST /storage/v1/object/sign/{bucket}/{path}`로 발급한 signed URL이다.
- `RESULT_ASSET_URL_TTL_SECONDS`가 없으면 signed URL TTL은 3600초다.
- `RESULT_PUBLIC_BASE_URL`은 F-05 `POST /api/results`의 기존 `{ url }` 응답에 필요하며, GET에는 필요하지 않다.

F-09 한계:

- 대시보드는 Supabase에 업로드된 records만 표시한다.
- 키오스크가 오프라인으로 IndexedDB/localStorage에 큐잉한 결과는 이 PR에서 drain하지 않는다.
- Signed asset URL은 Supabase 버킷과 오브젝트 권한이 허용되어야 열릴 수 있다.
- 현재 F-05 녹화본은 전체 최종 가방 합성이 아니라 `overlayCanvas`를 기록한다.

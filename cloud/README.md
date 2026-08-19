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

Supabase에는 `results` 버킷과 `results` 테이블이 필요하다. 테이블은 최소한
`code`, `session_id`, `pattern_name`, `issued_at`, `tile_meta`, `video_path`,
`poster_path` 컬럼을 가진다.

# 리빙 비세토스 — 개발 세팅 가이드 (PO 뼈대)

작성: 2026-08-13 · 팀 빽빽한하마 · 이 문서와 `skeleton_v0.html`이 개발 킥오프 세트입니다.

---

## 0. 아키텍처 결정 로그

| 결정 | 선택 | 이유 |
| --- | --- | --- |
| 플랫폼 | **웹 (Electron 보류)** | 전 구간이 웹 기술. 데모는 `chrome --kiosk`로 충분. 부스 상설·자동실행·로컬 저장이 필요해지면 마지막 주에 래핑(≈1일) |
| 스택 | Vite + TypeScript (프레임워크 无) | 키오스크 단일 화면에 React 불필요, 5인 진입장벽 최소 |
| 패턴 엔진 | L1 프로시저럴(로컬) + L2 생성AI(비동기 승격) | 오프라인 폴백 = 데모 생명보험 |
| 통합 전략 | 걷는 스켈레톤 → 모듈 교체식 | 언제 멈춰도 '돌아가는 데모'가 존재 |

## 1. 먼저 할 일 — 스켈레톤 확인 (10분)

1. `skeleton_v0.html`을 Chrome에서 연다 → 카메라 허용
2. 버튼 0→1→2→3→4 순서로 눌러본다
3. **버튼 하나 = 모듈 하나 = 계약 핸드오프 하나.** 화면의 경계선이 곧 분업 경계선이다
4. 하단 '계약 뷰어'에서 모듈 사이에 실제로 오가는 JSON을 확인한다

> 킥오프 미팅에서 이걸 다 같이 띄워놓고 모듈을 지명하세요. "네 일은 이 함수를 좋은 버전으로 갈아 끼우는 것"이 한눈에 보입니다.

## 2. 모듈 분담

| 모듈 | 담당 | 스켈레톤에서 갈아 끼울 함수 | 완성 기준 (DoD) |
| --- | --- | --- | --- |
| A 비전·캡처 | ______ | `extractSeed()` | 조명 변화에도 안정적인 색·모션 추출, 마스크 품질 개선(경계 페더링) |
| B 패턴 엔진 | ______ | `generateTile()` | 문법 파라미터화(간격·밀도·모티프), 시드 고정 시 재현 가능, L2 생성AI 승격 연결 |
| C 렌더·연출 | ______ | `segLoop()`, `initBag()` | 2D 합성→WebGL 셰이더 승격, 실제 가방 GLTF 교체, 전환 연출 |
| D 결과물·웹 | ______ | (신규) | 8초 세로 영상 인코딩(MediaRecorder), QR 전송 페이지, 인증 카드, 주문 목업 |
| E 앱 셸·통합 | ______ (PO 겸 추천) | `btnAll` 로직 | ATTRACT→OWN 상태머신, 키오스크 화면 설계, 리허설 시나리오 |

## 3. 계약 (Contracts) — 이것만은 합의 없이 바꾸지 않는다

```ts
// src/contracts.ts — 모듈 간 국경. 변경은 팀 합의 + PR 리뷰 2인.
export interface FeatureSeed {
  dominantColors: [string, string, string]; // hex
  motionEnergy: number;  // 0~1
  rhythm: number;        // 0~1
}
export interface PatternTile {
  bitmap: ImageBitmap | HTMLCanvasElement;  // 1024px 권장, 반복 타일
  meta: { palette: string[]; spacing: number; seedRef: string };
}
export type MaskFrame = ImageBitmap;         // 인물 알파 마스크 (프레임 단위)
export type KioskState = 'ATTRACT' | 'CREATE' | 'TRANSFORM' | 'MATERIALIZE' | 'OWN';
```

각 모듈 폴더에는 **목(mock) 데이터**를 둔다 (`mocks/seed.json`, `mocks/tile.png`, `mocks/mask.png`). 옆 모듈이 늦어도 내 개발은 멈추지 않는다.

## 4. 리포 구조 (Vite + TS)

```
living-visetos/
├─ index.html            # 키오스크 진입점
├─ src/
│  ├─ contracts.ts       # ★ 계약 — 국경
│  ├─ app/state.ts       # E: 상태머신
│  ├─ vision/            # A: 캡처·세그멘테이션·씨앗
│  ├─ pattern/           # B: L1 엔진, L2 승격
│  ├─ render/            # C: 오버레이 셰이더, 3D 가방
│  ├─ output/            # D: 영상·QR·인증카드
│  └─ mocks/             # 모듈별 목 데이터
├─ public/assets/        # 가방 GLTF, 폰트, 사운드
└─ docs/                 # 기획서 링크, 회의록
```

시작 명령: `npm create vite@latest living-visetos -- --template vanilla-ts` 후 위 구조로 폴더 생성, 스켈레톤 코드를 모듈별로 이식.

## 5. 협업 규칙 (가볍게, 그러나 항상)

- **브랜치**: `main`(항상 데모 가능) ← `feat/모듈-기능` PR. 리뷰 1인, `contracts.ts` 변경만 2인
- **이슈**: 기획서 기능 ID로 등록 (`F-02 L1 밀도 파라미터화`), 라벨 = 모듈명
- **스탠드업**: 매일 디스코드 3줄 (한 것 / 할 것 / 막힌 것) — 회의 아님
- **통합의 날(주 1회)**: 다 같이 main에 붙여보고, 안 붙는 건 그 자리에서 해결하고 헤어진다. 통합 부채 이월 금지
- **데모 가능 상태 유지**: main이 깨진 채 24시간을 넘기지 않는다

## 6. 첫 주(W1) 체크리스트

- [ ] 리포 생성 + 이 구조 커밋 (PO)
- [ ] 킥오프: 스켈레톤 시연 → 모듈 지명 → 계약 리뷰 (전원)
- [ ] 스켈레톤 코드 모듈별 이식 (각자, 반나절)
- [ ] A: 마스크 품질 스파이크 / B: 문법 파라미터 5개 정의 / C: GLTF 가방 소싱 + 셰이더 스파이크 / D: MediaRecorder 검증 / E: 상태머신 골격
- [ ] 첫 '통합의 날' — 스켈레톤보다 나은 v0.1 확인

## 7. 데모데이 직전 (미리 알아두기)

- 키오스크 실행: `chrome --kiosk --autoplay-policy=no-user-gesture-required file://.../index.html` (또는 로컬 서버)
- 조명 리허설 필수 — 세그멘테이션은 조명에 민감. 발표장 답사 시 스켈레톤으로 현장 테스트
- 폴백 3단: L2 실패→L1만 / 카메라 실패→목 마스크 시연 / 전체 실패→사전 녹화 영상

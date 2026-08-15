# 리빙 비세토스 (living-visetos)

관객이 서면 패턴이 태어나고, 그 패턴이 가방이 된다 — 키오스크 체험.
팀 **빽빽한하마** · Vite + TypeScript (프레임워크 无, ADR-001)

## 빠른 시작

```bash
npm install
npm run dev          # http://localhost:5173 → 카메라 허용 → 버튼 0→1→2→3→4
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
| [`docs/DESIGN.md`](docs/DESIGN.md) | 어떻게 보이는가 (팔레트, 타이포, 컴포넌트) |
| [`docs/skeleton_v0.html`](docs/skeleton_v0.html) | 이 리포가 태어난 v0 걷는 스켈레톤 (히스토리 · 단일 파일로 실행 가능) |

## 구조와 담당

```
src/
├─ contracts.ts   ★ 모듈 간 국경 — 변경은 팀 합의 + PR 리뷰 2인
├─ app/           E 앱 셸·통합    state.ts (상태머신 골격)
├─ vision/        A 비전·캡처     capture.ts / segmenter.ts / seed.ts
├─ pattern/       B 패턴 엔진     l1.ts (프로시저럴) / l2.ts (생성AI 승격 스텁)
├─ render/        C 렌더·연출     overlay.ts (실루엣) / bag.ts (3D 가방)
├─ output/        D 결과물·웹     recorder.ts (스텁)
└─ mocks/         모듈별 목 데이터 — 옆 모듈이 늦어도 내 개발은 멈추지 않는다
public/models/    A: 세그멘테이션 모델 로컬 번들 (예정)
public/assets/    C: 가방 GLTF, 폰트, 사운드
cloud/            D: Vercel Functions + 결과 페이지 (예정)
```

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

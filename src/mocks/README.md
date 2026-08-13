# mocks — 옆 모듈이 늦어도 내 개발은 멈추지 않는다

DEV_SETUP §3 규칙에 따른 모듈 간 목(mock) 데이터. 계약(`src/contracts.ts`)과 **같은 모양**을 유지한다.

| 파일 | 계약 | 쓰는 사람 |
| --- | --- | --- |
| `seed.json` | `FeatureSeed` | B(패턴) — A 없이 타일 생성 |
| `tile.png` | `PatternTile.bitmap` (512px, 실제 L1 출력 예시) | C(렌더) — B 없이 오버레이·가방 텍스처 |
| `mask.png` | `MaskFrame` (흰색 = 사람) | C(렌더) — 카메라 없이 합성 검증, 폴백 데모 |

```ts
import seed from '../mocks/seed.json';
import tileUrl from '../mocks/tile.png';

const bitmap = await createImageBitmap(await (await fetch(tileUrl)).blob());
```

> `tile.png`는 `seed.json`을 L1 엔진에 넣었을 때 나오는 그림과 같다(관객 색 35% 혼합).
> 단 해상도가 절반(512)이라 격자 간격도 절반이다 — 실제 `PatternTile.meta.spacing`은 1024 기준 **77**.
> 계약이 바뀌면 이 파일들도 같은 PR에서 갱신한다.

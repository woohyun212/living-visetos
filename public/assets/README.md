# public/assets — 에셋 출처와 라이선스

이 디렉터리의 바이너리는 **모두 리포에 커밋된 로컬 번들**이다. 런타임에 CDN을 타지 않는다 (ADR-003).
새 에셋을 추가하면 아래 표에 출처·라이선스를 같이 적는다. 모르면 비워두지 말고 **`확인 필요`** 로 적는다.

| 파일 | 용도 | 출처 | 라이선스 | 상태 |
| --- | --- | --- | --- | --- |
| `bag.glb` | F-04 3D 가방 프리뷰 (`src/render/bag.ts`) | **확인 필요** | **확인 필요** | ⚠️ 미확인 |
| `fonts/PretendardVariable.woff2` | 키오스크·결과 페이지 UI 폰트 | [orioncactus/pretendard](https://github.com/orioncactus/pretendard) | SIL Open Font License 1.1 | ✅ 확인됨 |

같은 원칙으로 관리되는 인접 디렉터리:

| 경로 | 용도 | 출처 | 라이선스 | 상태 |
| --- | --- | --- | --- | --- |
| `public/models/selfie_segmenter.tflite` | F-01 세그멘테이션 모델 (커밋됨) | Google MediaPipe Selfie Segmenter | Apache License 2.0 | ✅ 확인됨 |
| `public/wasm/*` | `@mediapipe/tasks-vision` wasm 런타임 (gitignore, `postinstall` 이 복사) | npm `@mediapipe/tasks-vision` | Apache License 2.0 | ✅ 확인됨 |

## ⚠️ `bag.glb` — 출처 확인 필요

- 리포에 처음 들어온 커밋: `8c4c49f feat: implement 3D bag product preview` (2026-08-19, author `unknown`).
  커밋 메시지·PR·문서 어디에도 모델 출처가 남아 있지 않다. `docs/DEV_SETUP.md` §2 의 C 담당 과제
  "실제 가방 GLTF 교체"의 결과물로 보이지만 **어디서 받았는지, 어떤 라이선스인지 확인되지 않았다.**
- 파일 메타데이터에도 단서가 없다: `generator: pygltflib@v1.16.5` (변환 도구일 뿐 출처가 아님),
  `copyright`/`asset.extras` 필드 없음.
- **데모데이 전에 C 담당이 출처와 재배포 가능 여부를 확인해 이 표를 채워야 한다.** 확인되지 않으면
  외부 공개 배포(Vercel 프로덕션)에는 쓰지 않는 것이 안전하다.

## `bag.glb` 최적화 이력 (2026-08-21)

원본 14.89 MB(무압축·347,011 삼각형·2048² 텍스처 3장)를 아래 파이프라인으로 **2.99 MB (−79.9%)** 로 줄였다.

```bash
npx @gltf-transform/cli optimize bag.orig.glb bag.glb \
  --compress quantize \
  --texture-compress webp --texture-size 1024 \
  --simplify true --simplify-ratio 0.35 --simplify-error 0.0001
```

| 항목 | before | after |
| --- | --- | --- |
| 파일 크기 | 14.89 MB | 2.99 MB (−79.9%) |
| 삼각형 | 347,011 | 124,252 (−64%) |
| 정점 속성 | `POSITION/NORMAL:f32`, `TEXCOORD_0:f32` | `i16_norm` / `u16_norm` (KHR_mesh_quantization) |
| 텍스처 3장 | 2048² JPEG, 합계 4.87 MB | 1024² WebP, 합계 98 KB |
| glTF 확장 | 없음 | `KHR_mesh_quantization`, `EXT_texture_webp` |

**왜 draco/meshopt 가 아닌가.** 둘 다 three.js 에서 디코더를 따로 등록해야 한다
(`GLTFLoader.setDRACOLoader()` / `setMeshoptDecoder()`) — `src/render/bag.ts` 의 로더 코드를 고쳐야 하고
디코더 wasm 도 같이 번들해야 한다. 반면 `KHR_mesh_quantization` 과 `EXT_texture_webp` 는
three r160 `GLTFLoader` 가 **기본으로 처리한다** (`GLTFMeshQuantizationExtension`,
`GLTFTextureWebPExtension` 이 생성자에서 자동 등록). 그래서 **`bag.ts` 는 한 줄도 바뀌지 않는다.**

**시각 확인.** 원본과 최적화본을 `bag.ts` 와 동일한 씬(카메라 fov 38 / position (0,0.6,4.2), Ambient 1.15 +
Directional 1.6)에서 나란히 렌더해 비교했다. 무대 실제 크기(600×600 CSS, `devicePixelRatio` 2)에서
베이스컬러 상태·패턴 타일 적용 상태 모두 육안 차이 없음. 바운딩 박스는 `2.0506×1.9636×1.4996` →
`2.0505×1.9636×1.4995` (양자화 오차, 스케일 변화 없음).

원본이 필요하면 `git show 70504ec:public/assets/bag.glb > bag.orig.glb` 로 꺼낸다.

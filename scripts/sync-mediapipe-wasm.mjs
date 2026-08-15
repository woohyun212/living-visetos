/**
 * ADR-003: @mediapipe/tasks-vision 의 wasm 런타임을 public/wasm 으로 복사한다.
 * public/wasm 은 커밋하지 않는다(.gitignore) — postinstall·predev·prebuild 에서 항상 동기화되므로
 * npm 패키지 버전과 정적 자산이 어긋날 수 없다. 모델(public/models/*.tflite)은 커밋 대상.
 */
import { cpSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = join(root, 'public', 'wasm');

if (!existsSync(src)) {
  console.error('[sync-mediapipe-wasm] node_modules/@mediapipe/tasks-vision/wasm 이 없습니다 — npm install 먼저');
  process.exit(1);
}
cpSync(src, dest, { recursive: true });
console.log('[sync-mediapipe-wasm] public/wasm 동기화 완료');

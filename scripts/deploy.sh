#!/usr/bin/env bash
# 자체 서버(단일 VM) 배포: 빌드 -> rsync -> systemd 재시작을 한 번에 수행한다.
# 리포가 private 이라 서버에서 git clone 하지 않는다. 산출물만 밀어 넣는다.
#
# 사용법:
#   scripts/deploy.sh <ssh-target>              # 예: scripts/deploy.sh root@203.0.113.10
#   DEPLOY_HOST=living-visetos scripts/deploy.sh
#
# 환경변수:
#   DEPLOY_HOST     ssh 대상(user@host 또는 ~/.ssh/config 별칭). 인자로 주면 그 값이 우선한다.
#   DEPLOY_PATH     서버 배포 경로 (기본값: /opt/living-visetos)
#   DEPLOY_SERVICE  systemd 유닛 이름 (기본값: living-visetos)
#   SKIP_BUILD=1    이미 빌드한 dist/ 를 그대로 보낼 때
#
# 서버 사전 준비(최초 1회)는 cloud/README.md "자체 서버 호스팅" 절 참고.
# 비밀값은 서버의 /etc/living-visetos.env 에만 두며 이 스크립트는 건드리지 않는다.

set -euo pipefail

DEPLOY_HOST="${1:-${DEPLOY_HOST:-}}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/living-visetos}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-living-visetos}"

if [ -z "$DEPLOY_HOST" ]; then
  echo "error: 배포 대상이 없다. scripts/deploy.sh <ssh-target> 또는 DEPLOY_HOST 를 지정한다." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> 대상: $DEPLOY_HOST:$DEPLOY_PATH (서비스: $DEPLOY_SERVICE)"

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> 빌드"
  npm ci
  npm run build
else
  echo "==> 빌드 건너뜀 (SKIP_BUILD=1)"
fi

if [ ! -d dist ]; then
  echo "error: dist/ 가 없다. 빌드가 실패했는지 확인한다." >&2
  exit 1
fi

# openrsync(macOS 기본)에는 --mkpath 가 없으므로 원격 디렉터리를 먼저 만든다.
echo "==> 원격 디렉터리 준비"
ssh "$DEPLOY_HOST" "mkdir -p '$DEPLOY_PATH/dist' '$DEPLOY_PATH/api'"

echo "==> dist/ 전송"
rsync -az --delete -e ssh dist/ "$DEPLOY_HOST:$DEPLOY_PATH/dist/"

# api/*.ts 는 서버에서 node --experimental-transform-types 로 직접 로드하므로 소스 그대로 보낸다.
echo "==> api/ 전송"
rsync -az --delete -e ssh api/ "$DEPLOY_HOST:$DEPLOY_PATH/api/"

# server.mjs 는 Node 내장 모듈만 쓴다. api 런타임 의존성이 없어 node_modules 를 보내지 않는다.
echo "==> server.mjs, package.json 전송"
rsync -az -e ssh server.mjs package.json "$DEPLOY_HOST:$DEPLOY_PATH/"

echo "==> 서비스 재시작"
ssh "$DEPLOY_HOST" "systemctl restart '$DEPLOY_SERVICE' && sleep 2 && systemctl is-active '$DEPLOY_SERVICE'"

echo "==> 헬스 체크"
# 서비스 포트는 서버의 env 파일이 정본이다(이 환경은 NAT 때문에 443 을 쓴다).
ssh "$DEPLOY_HOST" "PORT=\$(sed -n 's/^PORT=//p' /etc/${DEPLOY_SERVICE}.env 2>/dev/null | tail -1); \
  curl -sS -o /dev/null -m 15 -w 'local / -> %{http_code}\n' \"http://127.0.0.1:\${PORT:-443}/\""

echo "==> 배포 완료"

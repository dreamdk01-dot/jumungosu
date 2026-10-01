#!/usr/bin/env bash
# 브라우저 확인용 Tailwind CSS 를 로컬에서 만든다(운영은 app.html 이 Tailwind CDN 을 쓴다).
# 샌드박스처럼 외부 CDN 에 접근할 수 없는 곳에서 화면을 확인하기 위한 것.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
TMP="$(mktemp -d)"; cd "$TMP"
npm init -y >/dev/null 2>&1 && npm install tailwindcss@3 >/dev/null 2>&1
sed "s#/home/claude/site/app.html#$ROOT/app.html#" "$HERE/tailwind.config.cjs" > tailwind.config.cjs
printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > in.css
npx tailwindcss -c tailwind.config.cjs -i in.css -o "$HERE/tw.css"
echo "built $HERE/tw.css"

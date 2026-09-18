FROM node:20-slim AS base
WORKDIR /app

# Prisma 스키마 엔진 실행에 필요한 OpenSSL 설치 (node:20-slim에는 기본 포함되어 있지 않음)
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# 2026-09-18: 다우오피스 "전사 휴가현황" 스크래핑(leave-scraper.ts)용 Chromium 설치. 다우오피스
# 공식 API로는 휴가 여부를 구분할 수 없다는 게 이미 확인돼서(dauoffice.routes.ts 2026-09-04
# 기록) headless 브라우저로 그 화면을 직접 읽어온다. --with-deps가 폰트·libnss3 등 Chromium
# 실행에 필요한 OS 패키지까지 apt로 같이 설치해준다(이미지 용량이 꽤 늘어난다 — 정상).
RUN npx playwright install --with-deps chromium

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 4000
# 참고(MVP 한계): 정식 migration 파일 대신 `prisma db push`로 스키마를 DB에 직접 동기화한다.
# 전사 확산 단계에서는 `prisma migrate dev`로 migration 이력을 만들어 관리하는 것을 권장한다.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/server.js"]

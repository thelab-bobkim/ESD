FROM node:20-slim AS base
WORKDIR /app

# Prisma 스키마 엔진 실행에 필요한 OpenSSL 설치 (node:20-slim에는 기본 포함되어 있지 않음)
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

EXPOSE 4000
# 참고(MVP 한계): 정식 migration 파일 대신 `prisma db push`로 스키마를 DB에 직접 동기화한다.
# 전사 확산 단계에서는 `prisma migrate dev`로 migration 이력을 만들어 관리하는 것을 권장한다.
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/server.js"]

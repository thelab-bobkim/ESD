FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Prisma 스키마 엔진 실행에 필요한 OpenSSL 설치 (node:20-slim에는 기본 포함되어 있지 않음)
RUN apt-get update -y && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# 2026-09-30 수정(M-15): npm install → npm ci. lock 파일 그대로 설치해서 배포할 때마다 다른 버전이
# 깔리는 일(재현 불가능한 빌드)을 막는다. 빌드(tsc)에 devDependencies가 필요해서 --include=dev로 설치한다.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

# 2026-09-18: 다우오피스 "전사 휴가현황" 스크래핑(leave-scraper.ts)용 Chromium 설치. 다우오피스
# 공식 API로는 휴가 여부를 구분할 수 없다는 게 이미 확인돼서(dauoffice.routes.ts 2026-09-04
# 기록) headless 브라우저로 그 화면을 직접 읽어온다. --with-deps가 폰트·libnss3 등 Chromium
# 실행에 필요한 OS 패키지까지 apt로 같이 설치해준다(이미지 용량이 꽤 늘어난다 — 정상).
# 2026-09-30(M-15): 브라우저를 non-root 사용자도 읽을 수 있는 공용 경로에 설치한다.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 2026-09-30 수정(M-15): root가 아닌 node 사용자로 실행한다 — 앱에 취약점이 있더라도 컨테이너 안에서
# root 권한을 얻지 못하게(피해 범위 축소).
RUN chown -R node:node /app
USER node

EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 참고(MVP 한계): 정식 migration 파일 대신 `prisma db push`로 스키마를 DB에 직접 동기화한다.
# 2026-09-30 수정(M-15): 예전엔 매 기동마다 `--accept-data-loss`를 붙여서, 스키마에서 컬럼이 빠지거나
# 타입이 바뀌면 운영 데이터를 경고 없이 지웠다. 이제 기본은 안전 모드(데이터 손실이 생기는 변경이면
# 기동을 멈추고 로그로 알림)이고, 정말 필요할 때만 ALLOW_DB_DATA_LOSS=true로 명시적으로 허용한다.
CMD ["sh", "-c", "if [ \"$ALLOW_DB_DATA_LOSS\" = \"true\" ]; then npx prisma db push --skip-generate --accept-data-loss; else npx prisma db push --skip-generate; fi && node dist/server.js"]

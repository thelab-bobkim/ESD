FROM node:20-slim AS base
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
# 비워두면 브라우저 접속 주소 기준 "/api/v1"로 자동 연결(운영 기본값).
# 로컬 개발(compose)에서는 docker-compose.yml에서 http://localhost:4000/api/v1로 override.
ARG NEXT_PUBLIC_API_BASE_URL=
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]

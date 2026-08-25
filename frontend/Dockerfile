FROM node:20-slim AS base
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
# 비워두면 브라우저 접속 주소 기준 "/api/v1"로 자동 연결(운영 기본값).
# 로컬 개발(compose)에서는 docker-compose.yml에서 http://localhost:4000/api/v1로 override.
ARG NEXT_PUBLIC_API_BASE_URL=
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
# 고객사 위치 관리 화면(지도 검색/클릭 저장)에 쓰는 카카오맵 JavaScript 키. 도메인 제한이 걸려있어
# 이 값 자체는 공개되어도 안전하다(REST/어드민 키와 다름).
ARG NEXT_PUBLIC_KAKAO_MAP_KEY=
ENV NEXT_PUBLIC_KAKAO_MAP_KEY=$NEXT_PUBLIC_KAKAO_MAP_KEY
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]

# 전직원 상황판 및 근로시간 통합관리 시스템 (파일럿 MVP)

150인 규모 회사(본사 80명 + 고객사 상주 70명)를 위한 전직원 상황판 및 근로시간 통합관리 시스템의
파일럿 운영용 MVP입니다. 문서와 실행 가능한 코드가 함께 제공됩니다.

## 1. 문서 (읽는 순서 권장)

| 파일 | 내용 |
|---|---|
| `docs/PRD.md` | 요구사항 정리, 정책값 목록 |
| `docs/ARCHITECTURE.md` | 시스템 아키텍처 |
| `docs/DB_SCHEMA.md` | DB 테이블 설계(ERD 수준) |
| `docs/API_SPEC.md` | REST API 목록 |
| `docs/SCREENS.md` | 화면/기능 목록 |
| `docs/PILOT_PLAN.md` | 파일럿 운영 계획 |
| `docs/TEST_PLAN.md` | 테스트 계획(시나리오별 테스트케이스) |
| `DEPLOY.md` | **AWS Lightsail(Ubuntu, 도메인 없음, GitHub 배포) 실제 배포 가이드** — 처음 서버에 올릴 때는 이 문서부터 보세요 |
| `docs/DAUOFFICE_INTEGRATION.md` | 다우오피스(기존 AMS 시스템) 연동 설계 — 직원/근태 자동 동기화 |
| `HTTPS_SETUP.md` | 무료 도메인 + HTTPS(SSL) 설정 가이드 — 실제 서비스 시작 전 꼭 적용 권장 |

## 2. 폴더 구조

```
employee-status-system/
  docs/                     위 7개 설계 문서
  DEPLOY.md                 AWS Lightsail 배포 가이드
  backend/                  Node.js + TypeScript + Express + Prisma + PostgreSQL API 서버
  frontend/                 Next.js 기반 직원용/관리자용 웹 화면
  nginx/default.conf        운영 배포용 리버스 프록시 설정(80포트 하나로 프론트/백엔드 통합 노출)
  docker-compose.yml        로컬 개발용 (db+backend+frontend, 포트 개별 노출)
  docker-compose.prod.yml   AWS 등 운영 배포용 (nginx만 80포트 노출, DB_PASSWORD/JWT_SECRET 환경변수 필수)
  .env.prod.example         운영 배포용 환경변수 예시
```

## 3. 빠르게 실행하기 (Docker Compose — 권장)

사전 준비: Docker, Docker Compose 설치.

```bash
cd employee-status-system
docker compose up --build
```

기동 후:
- 프론트엔드: http://localhost:3000/login
- 백엔드 API: http://localhost:4000/api/v1/health
- DB 확인용 Adminer(선택): http://localhost:8080 (서버: `db`, 사용자: `app_user`, 비밀번호: `docker-compose.yml`의 값)

**최초 1회, 시드 데이터 생성**이 필요합니다 (컨테이너가 뜬 상태에서 별도 터미널로 실행):

```bash
docker compose exec backend npx prisma migrate deploy
docker compose exec backend npm run seed
```

시드 계정(비밀번호 공통: `SAMPLE_pass1234`):

| 이메일 | 역할 |
|---|---|
| sales1@sample.local | 영업직원(탄력근무) |
| eng1@sample.local | 엔지니어(탄력근무) |
| resident1@sample.local / resident2@sample.local | 고객사 상주자 |
| teamlead1@sample.local | 엔지니어팀 팀장(승인권한) |
| hr1@sample.local | 인사담당자 + 파일럿운영담당(정책설정/리포트/파일럿) |
| admin1@sample.local | 시스템관리자(감사로그 조회 등 전체 권한) |

## 4. 로컬 개발 환경에서 직접 실행하기

### 4-1. DB 준비
로컬에 PostgreSQL 16을 설치하거나, `docker run -d -p 5432:5432 -e POSTGRES_USER=app_user -e POSTGRES_PASSWORD=CONFIGURABLE_change_me -e POSTGRES_DB=employee_status postgres:16` 로 DB만 띄웁니다.

### 4-2. 백엔드

```bash
cd backend
cp .env.example .env   # 필요시 DATABASE_URL, JWT_SECRET 수정
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run seed
npm run dev             # http://localhost:4000
```

> **참고**: `npx prisma generate` / `migrate`는 Prisma의 쿼리 엔진 바이너리를 다운로드하기 위해
> 인터넷 접속이 필요합니다(사내망 프록시 환경이라면 허용 목록에 `binaries.prisma.sh`를 추가해야 합니다).

### 4-3. 프론트엔드

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev              # http://localhost:3000
```

## 5. 핵심 기능 요약

- **직원**: 로그인 → 출근/퇴근, 상태변경(9종), 고객사 상주 도착체크, 휴게, 야간근무 시작/종료,
  대체휴무/보상휴가 신청, 본인 근태 이력 조회
- **관리자(팀장/HR/시스템관리자)**: 전사/부서별/고객사별 상황판, 예외 알림(미출근/장시간근무/야간근무 후
  미전환/상태 미확인), 직원 상세 조회(역할별 필드 마스킹 + 감사로그), 승인 워크플로우, 정책값 설정,
  파일럿 그룹 관리, 감사로그 조회, 리포트(CSV) 추출
- **정책 엔진**: 야간근무 판정시간, 전환비율, 초과근무 경고기준 등은 전부 `policy_settings` 테이블 값으로
  동작하며 코드 하드코딩이 없습니다. HR 제도가 확정되기 전까지는 `PRD.md` 8절의 초기값(`CONFIGURABLE_` 접두)을
  그대로 사용하다가, `/api/v1/policy/settings`(HR_ADMIN/SYSTEM_ADMIN 권한)로 값을 조정하면 됩니다.
- **개인정보 보호**: 좌표 기반 위치추적은 구현하지 않았습니다(`ENABLE_GPS_TRACKING` 정책은 항상 `false`이며,
  실제 위경도 저장 테이블 자체가 존재하지 않습니다). 고객사 상주자는 "도착 여부/현재 상태/마지막 확인시각"만 기록합니다.

## 6. 알려진 MVP 한계 (전사 확산 전 개선 권장 사항)

- 예외 알림은 조회 시점에 즉석 계산하는 방식입니다. 실사용 규모에서는 배치/스케줄러로 전환 권장(`ARCHITECTURE.md` 7절).
- `policy_settings`의 전사 기본값(스코프 없음) 동시수정 시 경합 가능성이 있습니다(`policy.routes.ts` 주석 참조).
- 인증은 자체 이메일/비밀번호 기반입니다. 다우오피스 SSO/Keycloak 연동은 `auth` 모듈 인터페이스 분리 후 차기 확장 지점입니다.
- 알림 발송(사내 메신저 등) 연동은 아직 없고, 화면 조회 기반입니다.

## 7. 다음 단계

1. 파일럿 대상자 확정 → `/pilot/groups` API 또는 관리자 화면(A8)에서 그룹 생성
2. `docs/PILOT_PLAN.md`의 Phase 0~3 순서로 운영
3. HR 제도(탄력근무/보상휴가/대체휴무 규정) 확정 시 정책값만 갱신 (코드 변경 불필요)
4. 파일럿 결과를 바탕으로 `docs/TEST_PLAN.md` TC-1~TC-7 전체 재검증 후 전사 확산 검토

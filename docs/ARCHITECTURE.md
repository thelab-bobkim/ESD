# ARCHITECTURE — 시스템 아키텍처

## 1. 3계층 구조 개요

```
┌─────────────────────────────┐
│  Client (Next.js, 반응형)    │
│  - 직원용 웹/모바일 화면     │
│  - 관리자/인사용 데스크탑 화면│
└──────────────┬───────────────┘
               │ HTTPS / REST (JSON)
┌──────────────▼───────────────┐
│  Application / API Server    │
│  Node.js + Express + TS      │
│  - Auth/RBAC                 │
│  - 근태/상태 도메인 서비스    │
│  - 정책 엔진 (policy engine) │
│  - 승인 워크플로우 엔진      │
│  - 감사로그 미들웨어         │
└──────────────┬───────────────┘
               │ Prisma ORM
┌──────────────▼───────────────┐
│  PostgreSQL                  │
│  - 운영 데이터                │
│  - 감사로그(분리 테이블/스키마)│
└───────────────────────────────┘
```

기술스택 비고: 요구사항의 "권장 스택"은 NestJS/FastAPI였으나, 파일럿 MVP는 동일한
계층형·모듈형 구조를 Express + TypeScript + Prisma로 구현했다. 컨트롤러-서비스-리포지토리
계층 분리를 NestJS 마이그레이션이 가능하도록 유지했으며(`/backend/src/modules/<domain>` 구조),
전사 확산 단계에서 NestJS로 옮기는 것을 권장한다 (`PILOT_PLAN.md` 참조).

## 2. 모듈 구성 (Backend)

```
backend/src/
  modules/
    auth/            - 로그인, JWT 발급, 세션
    users/           - 사용자/조직 관리
    attendance/      - 출퇴근, 상태변경, 휴게, 야간근무 등록
    resident/        - 고객사 상주 도착체크/상태
    leave-conversion/ - 대체휴무/보상휴가 신청·승인
    approval/        - 승인 워크플로우 공통 엔진
    dashboard/       - 전사/부서/고객사별 상황판 집계 API
    alerts/          - 예외 알림 계산(미출근/장시간/미전환/미확인)
    policy/          - 정책값 CRUD
    pilot/           - 파일럿 그룹/기간/리포트
    audit/           - 감사로그 기록/조회
    reports/         - 리포트/정산 데이터 추출
  common/
    guards/          - RBAC 가드, 필드 마스킹
    middlewares/      - audit 미들웨어, 에러 핸들러
    policy-engine/   - 정책값 로딩·캐시·평가 유틸
  prisma/
    schema.prisma
    seed.ts
```

## 3. RBAC 설계

- 인증: 이메일/사번 + 비밀번호 (초기), JWT 액세스/리프레시 토큰
  - 향후 다우오피스 SSO/Keycloak 연동 지점을 `auth/strategies/`에 인터페이스로 분리해둠
- 인가: `role` 기반 + `scope`(본인/소속팀/전사) 조합
  - 예: `TEAM_LEAD`는 `attendance:read:team`, `EMPLOYEE`는 `attendance:read:self`
- 위치정보 상세조회는 별도 권한(`location:read:detail`)로 분리하여 대시보드 기본 조회 권한과 다르게 부여
- 필드 단위 마스킹: 응답 직렬화 시 역할에 따라 특정 필드(정확 위치, 연락처 등) 마스킹 또는 생략

## 4. 정책 엔진 (Policy Engine)

- `policy_settings` 테이블에서 key-value(+group/구간 조건)로 정책 로드
- 서버 기동 시 캐시, 관리자가 변경하면 캐시 무효화(간단한 버전 카운터 방식)
- 야간근무 판정, 초과근무 경고, 전환 비율 등 모든 "숫자/기준 판단"은 정책 엔진을 통해서만 계산 (하드코딩 금지)

## 5. 감사로그 설계

- 별도 테이블(`audit_logs`)로 분리, 운영 데이터와 다른 보관주기(`DATA_RETENTION_MONTHS`)로 관리 가능
- 기록 대상: 관리자 조회, 상태변경, 승인/반려, 정정, 정책값 변경, 위치 상세조회
- 감사로그는 수정 불가(append-only), 삭제는 시스템 관리자 전용 배치(보관기간 만료 시)에서만 수행

## 6. 데이터 흐름 예시 (야간근무 → 대체휴무 전환)

1. 엔지니어가 22:00 "야간근무 시작" 등록 → `night_work_sessions` 생성 (상태: IN_PROGRESS)
2. 익일 02:00 "야간근무 종료" 등록 → 세션 종료, 실근무시간 계산
3. 정책 엔진이 `NIGHT_WORK_COMPENSATION_TYPE`, `NIGHT_TO_LEAVE_CONVERSION_RATE` 조회
4. `leave_conversion_requests`에 "대체휴무 후보" 자동 생성 (직원 확인 후 정식 신청으로 전환)
5. 팀장/HR 승인 워크플로우(`approval_requests`) 진입
6. 승인 완료 시 `leave_balances` 갱신, 상황판/알림에 반영
7. 모든 단계는 `audit_logs`에 기록

## 7. 배포 구조 (Docker)

- `docker-compose.yml`: `db`(postgres), `backend`(node), `frontend`(next.js), 선택적 `adminer`
- 환경변수는 `.env`로 분리 (`.env.example` 제공)
- 파일럿 단계는 단일 서버(온프레미스 또는 사내망 VM) Docker Compose 배포를 기본 가정

## 8. 확장 시 고려사항 (전사 확산 단계)

- NestJS로 마이그레이션 (모듈 경계는 이미 도메인별로 분리되어 있어 전환 비용 최소화)
- 다우오피스 Open API 연동으로 조직/인사 마스터 동기화
- Keycloak/SSO 연동
- 알림 채널(사내 메신저) 연동은 알림 발송을 인터페이스(`NotificationPort`)로 추상화해 추후 구현체만 교체

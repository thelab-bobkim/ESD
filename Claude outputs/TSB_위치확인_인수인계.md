# TSB(전사 상황판) — 위치확인(GPS) 문제 인수인계 자료

이 문서는 새 Claude 세션에 그대로 붙여넣어서, 지금까지 진행된 "위치확인" 관련 작업을 이어서 진행할 수 있게 정리한 것입니다.

## 1. 프로젝트 개요

- **DSTI-TSB 상황판**: 약 150명 규모 회사(본사 80명 + 고객사 상주 70명)의 전직원 근무상태 상황판 + 근로시간 통합관리 시스템.
- **기술스택**: 프론트엔드 Next.js(pages router), 백엔드 Node.js/Express + TypeScript + Prisma + PostgreSQL 16(Docker), PWA(web-push).
- **저장소**: `https://github.com/thelab-bobkim/ESD.git`, 브랜치 `main`.
- **로컬 PC 경로**: `C:\Users\hp\Downloads\employee-status-system\employee-status-system` (Windows, PowerShell 사용).
- **운영 서버**: AWS Lightsail(ubuntu 계정), 프로젝트 경로 `~/employee-status-system`(= `/home/ubuntu/employee-status-system`).
- **배포 명령(반드시 `-f docker-compose.prod.yml --env-file .env.prod` 포함)**:
  ```bash
  cd employee-status-system
  git pull
  docker compose --env-file .env.prod -f docker-compose.prod.yml up --build -d
  ```
  기본 `docker-compose.yml`(옵션 없이)은 플레이스홀더 템플릿이라 잘못 실행하면 nginx가 orphan으로 제거되며 502 장애가 난 전례가 있음(2026-09-09, 이후 복구 완료).
- **DB 스키마 반영 방식**: 정식 `prisma migrate`가 아니라, 백엔드 컨테이너 시작 시 `npx prisma db push --skip-generate --accept-data-loss`로 자동 동기화(Dockerfile CMD에 포함). 즉 `schema.prisma`를 고치고 재빌드만 하면 DB 컬럼이 자동 반영됨 — 별도 마이그레이션 명령 불필요.
- **주의(자주 나오는 실수)**: `schema.prisma`는 `/** ... */` 블록 주석을 지원하지 않음(`prisma generate`가 Docker 빌드 중 실패함) — 반드시 `//` 줄 주석만 사용.
- **백업 태그**: `TSB-Ver2.1`(커밋 682aa67), `TSB-Ver2.3`(커밋 1de1b2e, DB 덤프 `~/backups/employee_status_TSB-Ver2.3.sql`) — "Ver2.x로 롤백해줘"라고 하면 해당 시점으로 복구.

## 2. 작업 환경 표준 제약사항 (매우 중요)

- **이 세션에는 `device_bash`(사용자 PC에서 직접 명령 실행)가 없음** — git/SSH/docker/SQL 등 실행이 필요한 모든 명령은 사용자에게 그대로 전달해서 본인이 직접 실행하게 해야 함. Claude가 대신 실행하면 안 됨.
- **응답은 반드시 한글로만** 작성.
- 파일 수정 시 표준 흐름: PC의 파일을 읽어서(device 브릿지 또는 첨부) 수정 → `/home/claude/work/{frontend,backend}`에 복사해 `npx tsc --noEmit` / `npx next build`로 검증 → 사용자에게 파일 전달 → PC에 다시 반영 → git add/commit/push 및 서버 배포 명령을 사용자에게 안내.
- 백엔드 `npx tsc --noEmit`은 샌드박스의 Prisma 타입 스텁 한계로 인해 기존에도 콜백 매개변수 implicit-any 오류가 약 40개 정도 기본으로 깔려있음(정상, 실제 타입체크는 서버 Docker 빌드에서 이뤄짐) — 새 코드가 콜백을 추가하면 +1~2개 정도 늘어나는 건 정상 범위.

## 3. 위치확인(GPS) 문제 히스토리

### 3-1. "위치 미확인 다수" 문제 1차 원인 (2026-09-09)
`dashboard.routes.ts`의 `buildStatusBoard`가 그날 "가장 최근" 상태변경 로그 1건만 보고 판단 → 하루에 여러 번 등록 시 마지막 등록이 대조 실패면 이전 성공 기록이 무시됨.
- 수정: (1) 그날 한 번이라도 `locationMatch=true` 이력이 있으면 확인됨으로 처리, (2) `hqLocationNote()`에 캡처는 성공(OK)했는데 비교 기준과 안 맞는 경우 전용 안내문구 추가.
- 결과: 31명 → 28명으로 소폭 개선(진짜 원인 아니었음).

### 3-2. "위치 미확인 다수" 문제 2차(진짜 주원인, 2026-09-09)
`attendance.routes.ts`의 **"/clock-in"(출근 버튼) 핸들러**에서, `hqVerifiedByAlternateMeans`(사내망 공인IP 또는 주소 키워드로 확인됨)가 true여도 `hqLocationResult`를 채워주는 코드가 빠져 있어서 계속 `null`로 남고 DB에는 `locationMatch: null`로 기록됨. 같은 로직을 쓰는 다른 핸들러(상태변경 API)는 2026-09-08에 이미 고쳐졌었는데 출근 버튼 핸들러만 누락돼 있었음.
- 수정: `hqConfigured && hqVerifiedByAlternateMeans`일 때 `hqLocationResult = { match: true, distance: 0 }`을 명시적으로 채움.
- 배포 완료됨.

### 3-3. 사내망 공인IP 허용목록 이슈
`HQ_ALLOWED_PUBLIC_IPS`에 실제 관측되는 공인IP(예: `106.101.75.167`)가 누락되는 경우가 있었음. 회사가 인터넷 회선을 여러 개(약 30여 개) 써서 어떤 IP를 누가/어디서 쓰는지 파악이 어려움.
- 대응: `[OfficeNetworkCheck]` 진단 로그에 `clientIp`뿐 아니라 `userId`도 함께 남기도록 `isRequestFromOfficeNetwork()` 수정(`attendance.routes.ts`) → 같은 IP에 여러 다른 userId가 몰리면 사무실 공용회선, 한 명만 계속 찍히면 개인회선으로 구분 가능. 로그는 컨테이너 재시작 시 초기화되므로 재배포 이후 누적분만 유효(며칠 지켜본 뒤 집계 필요).

### 3-4. 개별 직원 사례 (진유림)
"고객사 위치가 오류로 등록되어 있다"는 문의 → SQL로 진단한 결과, 실제로는 위치 캡처(`location_capture_status`)는 전부 정상(`OK`)이었고, 원인은 **고객사(client) 레코드 중복/좌표 누락**이었음("유라" vs "유라코퍼"/"유라코퍼레이션" — 중복 레코드 중 일부는 좌표가 비어있음). 관리자 UI에서 빈 레코드 삭제 또는 좌표 채워넣기로 정리 필요.

## 4. 최근 작업 — GPS 오차범위(accuracy) 반영 (가장 최근, 배포 진행 중)

### 문제
거리 기반 판정(`거리 ≤ 반경`)만 쓰다 보니, GPS 자체의 정확도가 낮게 잡힌 상황(예: 건물 안, 실내)에서 실제로는 맞는 위치인데도 "위치 불일치"로 잘못 판정되는 경우가 있었음.

### 해결 방식
- 프론트엔드(`geolocation.ts`)가 이미 계산해두고 있던 `accuracyMeters`(GPS 오차범위)를 위치 관련 요청 전체에 실어서 서버로 전송하도록 `frontend/pages/index.tsx` 3곳(출근/본사근무, 고객사미팅/고객사작업, 고객사상주 도착체크)을 수정.
- 서버(`backend/src/common/location.ts`)의 판정 로직을 `거리 ≤ 반경`에서 `거리 ≤ 반경 + 오차범위(최대 1000m까지만 인정)`로 변경 — GPS가 스스로 보고한 오차만큼만 관대하게 봐주고, 조작된 값으로 무한정 통과되지 않도록 상한을 둠.
- `attendance.routes.ts`(출근/상태변경)와 `resident.routes.ts`(도착체크) 양쪽에 오차범위 반영.
- DB: `StatusChangeLog`, `ResidentCheckin` 테이블에 `locationAccuracyMeters` 컬럼 각각 추가(`schema.prisma`).
- 관리자 대시보드(`frontend/pages/admin/dashboard.tsx`)에서 "위치 불일치 (약 800m · 오차범위 ±900m)"처럼 오차범위도 함께 표시해서 애매한 케이스와 명백한 불일치를 구분 가능하게 함.
- **하위호환**: 오차범위 없이 오는(구버전) 요청은 기존과 완전히 동일하게 동작.
- 마이그레이션 불필요(위 2번 항목 참고 — `db push` 자동 동기화 방식).

### 변경된 파일 (총 8개)
```
backend/prisma/schema.prisma
backend/src/common/attendance-helpers.ts
backend/src/common/location.ts
backend/src/modules/attendance/attendance.routes.ts
backend/src/modules/resident/resident.routes.ts
backend/src/modules/dashboard/dashboard.routes.ts
frontend/pages/admin/dashboard.tsx
frontend/pages/index.tsx
```
(diff 통계: 145줄 추가 / 20줄 삭제 — 커밋 시 확인 완료)

같은 커밋에 "잠정 본사근무 라벨 표시 수정"도 함께 포함되어 있음(본사근무 상태가 잠정(추정) 상태로 표시되던 라벨 관련 수정 — 세부 diff는 커밋 `ad1d3da` 참고).

### 현재 배포 상태 — ⚠️ 여기서부터 이어서 진행 필요
1. **완료**: 로컬 PC에서 `git add` → `git commit -m "fix: 위치 오차범위(accuracy)를 판정에 반영, 잠정 본사근무 라벨 표시 수정"` → `git push` 까지 성공 확인(커밋 해시 `ad1d3da`, GitHub `main` 브랜치에 반영됨: `4f447a3..ad1d3da main -> main`).
2. **미확인(다음 단계)**: AWS 서버(Lightsail)에서의 `git pull` + `docker compose --env-file .env.prod -f docker-compose.prod.yml up --build -d` 실행 및 배포 로그 확인이 아직 사용자로부터 확인받지 못한 상태. 새 세션에서는 이 SSH 배포 단계부터 이어서 안내하고, 로그(`docker compose -f docker-compose.prod.yml logs -f backend`)에서 `prisma db push`가 오류 없이 새 컬럼 2개(`locationAccuracyMeters` ×2)를 반영하는지 확인해야 함.
3. 배포 확인 후 브라우저에서 실제 위치 판정이 오차범위를 반영해 개선됐는지(현장 재현 또는 관리자 화면에서 "오차범위 ±Nm" 표시 확인) 검증 필요.

### 다음 우선순위(2순위, 아직 미착수)
고객사별로 위치 반경을 개별 설정하는 기능 — 이번 오차범위 반영이 며칠 운영되면서 데이터가 쌓인 뒤(어떤 고객사가 유독 GPS 오차가 큰지 실측 확인 후) 진행하는 것을 권장한 상태.

## 5. 이번 세션에서 별도로 완료된 다른 작업(참고용, 위치확인과는 무관)
- "진행중" 체크박스(고객사작업/야간작업/주말작업 완료시간 없이 등록) 기능 배포 완료.
- 관리자→직원 및 직원→관리자 양방향 메시지 기능(상황판 아바타 클릭) 배포 완료.
- 고객사작업 등 "진행중" 등록을 다시 열었을 때 기존 입력값을 이어받는 기능(EffortLog `sourceStatus` 이어받기) 구현 및 PC 반영 완료 — 커밋/배포는 사용자 몫으로 안내함.

이 두 항목은 지금 요청한 "위치확인" 이슈와는 독립적인 작업이라 새 세션에 굳이 안 넘겨도 되지만, 혹시 커밋 이력을 볼 때 섞여 보일 수 있어 참고로 남겨둠.

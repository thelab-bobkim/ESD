# DAUOFFICE_INTEGRATION — 다우오피스(AMS) 연동 설계

## 1. 배경

기존에 운영 중인 근태관리 시스템 `AMS`(thelab-bobkim/AMS, Flask+Vue)가 다우오피스 OpenAPI로
직원/근태 데이터를 동기화하고 있었다. ESD는 AMS의 `backend/dauoffice_api.py`, `models.py`,
`config.py` 로직을 참고하여 동일한 다우오피스 조직도/근태 API를 **직접, 독립적으로** 호출하도록
이식했다. AMS는 그대로 두고(월별 정산/엑셀용), ESD는 별도로 다우오피스에서 데이터를 읽어온다.

```
다우오피스 OpenAPI (읽기 전용 호출)
     ├──────────────► AMS  (기존 유지, 월별 정산/엑셀)
     └──────────────► ESD  (신규, 실시간 상황판/워크플로우)
```

ESD는 AMS의 DB나 서버에 전혀 접근하지 않는다.

## 2. 스키마 변경 사항 (기존 배포본 대비)

| 변경 | 이유 |
|---|---|
| `Department.type`을 필수 → 선택값으로 변경 | 실제 회사 부서가 90여개 팀명이라 4개 유형으로 억지로 분류할 수 없음. `type`은 이제 정책 판단용 참고 태그일 뿐 |
| `Department.name`에 `@unique` 추가 | 다우오피스 동기화 시 부서명 기준으로 upsert하기 위함 |
| `User.email`을 필수 → 선택값으로 변경 | 다우오피스 동기화 계정은 이메일 정보가 없음 |
| `User.dauofficeUserId`, `User.dataSource` 추가 | 다우오피스 계정과의 매칭 및 수동/자동 데이터 구분 |
| `AttendanceRecord.dataSource` 추가 | 자동 동기화가 관리자의 수동 정정 기록을 덮어쓰지 않도록 보호 |
| `DauofficeToken` 테이블 신규 | OAuth2 액세스 토큰 캐시(AMS와 동일한 목적) |
| `DauofficeDepartmentOverride` 테이블 신규 | AMS 코드에 하드코딩되어 있던 91명분 부서 보정 딕셔너리(DEPT_MAP)를 DB로 이전. 시드 데이터로 최초 적재됨 |

> 이미 배포된 서버에 `prisma db push`로 반영하면, 위 변경은 전부 컬럼 추가/제약 완화라 기존 데이터가
> 삭제되지는 않는다. 다만 배포 전 DB 백업을 권장한다 (`docker exec ... pg_dump`).

## 3. 로그인 방식 변경

- 다우오피스 동기화 계정은 이메일이 없으므로, 로그인 API가 `email` 대신 `identifier`를 받도록 변경했다.
- `identifier`에는 이메일 또는 사번(=다우오피스 로그인ID)을 넣을 수 있다.
- 기존 시드 계정(이메일 있음)은 이메일로도, 사번으로도 로그인 가능하다.

## 4. 부서/근무유형 자동 매핑

- **부서명**: `DauofficeDepartmentOverride` 테이블에 값이 있으면 그 값을 우선 사용하고, 없으면
  다우오피스 조직도 응답(`userGroups`)에서 추출한다(AMS의 `_extract_department` 로직과 동일).
- **근무유형(탄력/고정/상주)**: 다우오피스에 없는 ESD 개념이라, 정책값 `DEPARTMENT_WORKTYPE_RULES`
  (부서명에 특정 문자열이 포함되면 어떤 workType을 줄지 순서대로 정의한 규칙 목록)로 자동 판정한다.
  일치하는 규칙이 없으면 `DEFAULT_SYNCED_WORK_TYPE`(기본값 `HQ_FIXED`)를 사용한다.
  **초기 규칙은 시드 데이터의 추정값이므로, 실제 조직에 맞게 정책값을 검토/수정해야 한다.**
  (`PUT /api/v1/policy/settings`, key=`DEPARTMENT_WORKTYPE_RULES`, valueType=`JSON`)

## 5. API

| Method | Path | 설명 | 권한 |
|---|---|---|---|
| POST | /api/v1/dauoffice/sync/employees | 직원(조직도) 수동 동기화 | HR_ADMIN/SYSTEM_ADMIN |
| POST | /api/v1/dauoffice/sync/attendance | 근태(출근) 수동 동기화 `{year, month}` | HR_ADMIN/SYSTEM_ADMIN |
| GET | /api/v1/dauoffice/department-overrides | 부서명 보정값 목록 | HR_ADMIN/SYSTEM_ADMIN |
| PUT | /api/v1/dauoffice/department-overrides | 부서명 보정값 추가/수정 `{dauofficeLoginId, departmentName}` | HR_ADMIN/SYSTEM_ADMIN |
| DELETE | /api/v1/dauoffice/department-overrides/:loginId | 부서명 보정값 삭제 | HR_ADMIN/SYSTEM_ADMIN |

관리자 화면(UI)은 아직 없다. 우선 API로 검증한 뒤, 필요하면 관리자 화면을 추가할 수 있다.

## 6. 자동 동기화 (기본은 꺼짐)

- 정책값 `DAUOFFICE_AUTO_SYNC_ENABLED`가 `true`일 때만 자동으로 돈다 (기본값 `false`).
- 켜지면 정책값 `DAUOFFICE_SYNC_INTERVAL_HOURS`(기본 6시간) 주기로 직원/근태를 자동 동기화한다.
- **실제 운영 인사 데이터에 영향을 주는 기능이므로, 처음에는 반드시 수동 API(`POST /dauoffice/sync/employees`)로
  결과(동기화 인원 수, 오류 목록)를 확인한 뒤에 자동 동기화를 켤 것을 권장한다.**

## 7. 안전장치

- `DAUOFFICE_AUTO_DEACTIVATE_MANUAL_DUPLICATES`(기본 `false`): 수동입력 직원과 이름이 같은 다우오피스
  동기화 직원이 있을 때 수동입력 쪽을 자동으로 퇴사처리할지 여부. 동명이인 오탐 위험이 있어 기본 꺼짐.
- 다우오피스에서 빠진(퇴사/조직 이동) 계정은 `employmentStatus = TERMINATED`로 처리될 뿐, 데이터를
  삭제하지 않는다.
- 근태 동기화는 `dataSource = MANUAL`인 기존 기록을 절대 덮어쓰지 않는다 — 관리자가 손으로 고친 값은 보호된다.
- 모든 동기화 실행은 감사로그(`audit_logs`, target_type=`dauoffice_sync_employees`/`dauoffice_sync_attendance`)에 요약 기록된다.

## 8. 환경변수

```
DAUOFFICE_CLIENT_ID=      # 다우오피스 관리자 페이지에서 발급
DAUOFFICE_CLIENT_SECRET=
DAUOFFICE_API_URL=https://api.daouoffice.com
DAUOFFICE_TLS_INSECURE=false   # AMS 원본은 true였으나 ESD는 기본 안전하게 false 권장
```

값은 서버의 `.env.prod` 파일에만 넣고, 절대 GitHub에 커밋하지 않는다(`.gitignore`에 이미 포함됨).

## 9. 알려진 한계 / 향후 개선

- 근태 동기화는 다우오피스가 제공하는 **출근시각만** 반영한다(다우오피스 API 응답에 퇴근시각이 없음).
  퇴근/휴게/상태변경은 계속 ESD 자체 기능으로 관리한다.
- 자동 동기화 스케줄러는 정밀한 cron이 아니라 "정시 근처에 한 번" 방식의 단순 폴링이다. 전사 확산 단계에서는
  `node-cron`이나 별도 스케줄러 컨테이너로 교체하는 것을 권장한다.
- 부서 판정 실패(빈 문자열) 시 해당 직원은 동기화를 건너뛰고 오류 목록에 기록된다 — 이 경우
  `DauofficeDepartmentOverride`에 수동으로 추가해주어야 한다.

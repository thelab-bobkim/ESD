# DB_SCHEMA — 테이블 설계 (ERD 수준)

실제 정의는 `backend/prisma/schema.prisma`가 원본(source of truth)이며, 본 문서는 사람이 읽기 위한 요약이다.

## 1. 조직/사용자

### departments
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| name | text | 예: 영업팀, 엔지니어팀, 고객사상주팀 |
| type | enum(HQ_SALES, HQ_ENGINEER, HQ_ETC, RESIDENT) | 근무유형 그룹 구분 |
| parent_id | uuid FK→departments.id (nullable) | |

### clients (고객사)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| name | text | 고객사명 |
| address | text | 근무지 주소(도착체크용, 상세좌표 아님) |

### users
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| employee_no | text unique | 사번 |
| name | text | |
| email | text unique | |
| password_hash | text | |
| department_id | uuid FK | |
| assigned_client_id | uuid FK (nullable) | 고객사 상주자인 경우 소속 고객사 |
| work_type | enum(HQ_FLEX, HQ_FIXED, RESIDENT) | 근무유형(정책 판단 기준) |
| employment_status | enum(ACTIVE, ON_LEAVE, TERMINATED) | |
| created_at / updated_at | timestamptz | |

### roles / user_roles
| roles: id, code(EMPLOYEE/TEAM_LEAD/HR_ADMIN/SYSTEM_ADMIN/PILOT_MANAGER), name |
| user_roles: user_id FK, role_id FK, scope_department_id FK(nullable, TEAM_LEAD 범위) |

## 2. 근태/상태

### attendance_status_enum (값)
`HQ_WORKING, RESIDENT_ONSITE, OFFSITE, MEETING, MOVING, REMOTE, NIGHT_WORK, ALT_DAY_OFF, ON_LEAVE`

### attendance_records (일 단위 출퇴근)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | |
| work_date | date | |
| clock_in_at | timestamptz nullable | |
| clock_out_at | timestamptz nullable | |
| total_worked_minutes | int nullable | 계산값(휴게 제외) |
| is_corrected | boolean default false | 정정 여부 |
| correction_reason | text nullable | |

### status_change_logs (상태 변경 이력 — 상황판의 소스)
| id, user_id FK, status(enum), changed_at, note, source(WEB/MOBILE/SYSTEM) |

### break_sessions
| id, attendance_record_id FK, start_at, end_at |

### resident_checkins (고객사 상주 도착체크)
| id, user_id FK, client_id FK, checkin_at, checkin_method(enum: MANUAL/QR — MVP는 MANUAL), last_confirmed_at |

*설계 원칙: 좌표(lat/lng) 컬럼은 두지 않는다. 상세 위치가 필요해지면 별도 `location_events` 테이블 +
`ENABLE_GPS_TRACKING` 정책 스위치 + `location:read:detail` 권한으로 확장하되 MVP 범위에는 미포함.*

### night_work_sessions (야간근무)
| id, user_id FK, started_at, ended_at nullable, worked_minutes nullable, status(enum: IN_PROGRESS/COMPLETED), note |

## 3. 휴가/전환/승인

### leave_types
| id, code(ALT_DAY_OFF/COMP_LEAVE/ANNUAL 등), name |

### leave_balances
| id, user_id FK, leave_type_id FK, balance_minutes, updated_at |

### leave_conversion_requests (야간근무→대체휴무/보상휴가 전환)
| id, user_id FK, source_night_work_session_id FK, requested_leave_type_id FK, converted_minutes, status(enum: DRAFT/PENDING/APPROVED/REJECTED), created_at |

### approval_requests (공용 승인 워크플로우)
| id, type(enum: OVERTIME/NIGHT_WORK/LEAVE_CONVERSION/ATTENDANCE_CORRECTION), reference_id(대상 레코드 id), requester_id FK, approver_id FK nullable, status(enum: PENDING/APPROVED/REJECTED), requested_at, decided_at, comment |

## 4. 정책

### policy_settings
| id, key(unique), value(text/jsonb), value_type(enum: BOOLEAN/NUMBER/STRING/JSON), scope_department_id nullable, description, updated_by FK, updated_at |

*부서/그룹별로 다른 정책값이 필요한 경우 `scope_department_id`로 오버라이드, 없으면 전사 기본값 적용.*

## 5. 예외 알림

### alert_rules (임계값은 policy_settings 참조, 규칙 활성화 여부만 관리)
| id, code(NO_CLOCK_IN/LONG_WORKING/NIGHT_WORK_NOT_CONVERTED/STATUS_NOT_CONFIRMED), enabled |

### alerts (발생한 알림 인스턴스)
| id, rule_code, user_id FK, related_id, severity(enum: INFO/WARNING/CRITICAL), created_at, resolved_at nullable |

## 6. 파일럿

### pilot_groups
| id, name, description, start_date, end_date |

### pilot_group_members
| id, pilot_group_id FK, user_id FK |

### pilot_feedback
| id, pilot_group_id FK, user_id FK, category(enum: BUG/UX/POLICY/OTHER), content, created_at |

## 7. 감사로그 (별도 관심사 — 논리적으로 분리된 테이블)

### audit_logs
| id, actor_user_id FK nullable(시스템 액션은 null), action_type(enum: VIEW/STATUS_CHANGE/APPROVE/REJECT/CORRECT/POLICY_CHANGE/LOCATION_DETAIL_VIEW), target_type, target_id, before_value jsonb nullable, after_value jsonb nullable, ip_address, created_at |

- append-only, 애플리케이션 레벨에서 UPDATE/DELETE 금지 (DB 권한으로도 REVOKE 권장)
- 보관기간은 `policy_settings.DATA_RETENTION_MONTHS`로 관리, 만료분은 배치로만 삭제

## 8. 공수(工數) 관리

### effort_logs
| id, user_id FK, work_date, client_name, project_name, work_type, start_time, end_time(nullable, 진행중이면 null), minutes(nullable), description, created_at |

고객사 미팅/작업 상태를 등록할 때(`POST /attendance/status`의 `effort` 필드) 생성된다.
`status_change_logs.note`는 사람이 읽는 요약 문자열이고, 실제 주/월별·프로젝트별 집계는 이 테이블 기준.

## 9. 관계 요약 (텍스트 ERD)

```
departments 1---N users N---1 clients(assigned_client_id, optional)
users N---N roles (through user_roles)
users 1---N attendance_records 1---N break_sessions
users 1---N status_change_logs
users 1---N resident_checkins
users 1---N effort_logs
users 1---N night_work_sessions 1---1 leave_conversion_requests(optional)
users 1---N leave_balances N---1 leave_types
approval_requests -> (polymorphic reference_id) attendance_records / night_work_sessions / leave_conversion_requests
policy_settings (standalone, optional scope_department_id -> departments)
pilot_groups 1---N pilot_group_members N---1 users
audit_logs -> (polymorphic target_id) 전 테이블
```

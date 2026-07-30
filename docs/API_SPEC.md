# API_SPEC — REST API 목록 (MVP)

Base URL: `/api/v1`
인증: `Authorization: Bearer <JWT>` (로그인 API 제외 전체 적용)
공통 응답 포맷: `{ success: boolean, data?: any, error?: { code, message } }`

## 인증
| Method | Path | 설명 | 권한 |
|---|---|---|---|
| POST | /auth/login | 이메일/사번 + 비밀번호 로그인 | 공개 |
| POST | /auth/refresh | 토큰 갱신 | 로그인 사용자 |
| POST | /auth/logout | 로그아웃 | 로그인 사용자 |
| GET | /auth/me | 내 정보 + 역할 | 로그인 사용자 |

## 직원 — 근태/상태 (A)
| Method | Path | 설명 | 권한 |
|---|---|---|---|
| POST | /attendance/clock-in | 출근 처리 | EMPLOYEE(self) |
| POST | /attendance/clock-out | 퇴근 처리 | EMPLOYEE(self) |
| POST | /attendance/status | 현재 상태 변경(상태 enum) | EMPLOYEE(self) |
| GET | /attendance/me | 본인 오늘/기간 근태 조회 | EMPLOYEE(self) |
| GET | /attendance/me/history | 본인 이력 조회 | EMPLOYEE(self) |
| POST | /attendance/break/start | 휴게 시작 | EMPLOYEE(self) |
| POST | /attendance/break/end | 휴게 종료 | EMPLOYEE(self) |
| POST | /resident/checkin | 고객사 상주 도착 체크 | EMPLOYEE(self, RESIDENT) |
| POST | /night-work/start | 야간근무 시작 등록 | EMPLOYEE(self) |
| POST | /night-work/end | 야간근무 종료 등록(전환 후보 자동 생성) | EMPLOYEE(self) |
| POST | /leave-conversion/requests | 대체휴무/보상휴가 신청 | EMPLOYEE(self) |
| GET | /leave-conversion/requests/me | 본인 전환/신청 이력 | EMPLOYEE(self) |

## 관리자 — 상황판/조회/승인 (B)
| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | /dashboard/company | 전사 상황판 집계 | TEAM_LEAD/HR_ADMIN/SYSTEM_ADMIN(scope별 필터) |
| GET | /dashboard/department/:id | 부서별 현황판 | scope 확인 |
| GET | /dashboard/client/:id | 고객사별 상주 현황판 | scope 확인 |
| GET | /alerts | 예외 알림 목록(필터: 미출근/장시간/미전환/미확인) | TEAM_LEAD/HR_ADMIN/SYSTEM_ADMIN |
| GET | /users/:id | 직원 상세 조회(민감정보는 역할별 마스킹) | scope 확인, 감사로그 기록 |
| GET | /approval/requests | 승인 대기/이력 목록 | 승인권한 role |
| POST | /approval/requests/:id/approve | 승인 | 승인권한 role |
| POST | /approval/requests/:id/reject | 반려(사유 필수) | 승인권한 role |
| POST | /attendance/:id/correction | 근태 정정(정정 후 승인 필요) | TEAM_LEAD/HR_ADMIN |

## 인사/운영 (C)
| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET/PUT | /policy/settings | 정책값 조회/수정(그룹별) | HR_ADMIN/SYSTEM_ADMIN |
| GET | /reports/attendance-export | 근태 리포트/정산 데이터 추출(CSV) | HR_ADMIN |
| GET | /reports/night-work-export | 야간근무/전환 리포트 추출 | HR_ADMIN |

## 파일럿 (D)
| Method | Path | 설명 | 권한 |
|---|---|---|---|
| POST | /pilot/groups | 파일럿 그룹 생성 | PILOT_MANAGER/SYSTEM_ADMIN |
| POST | /pilot/groups/:id/members | 대상자 추가 | PILOT_MANAGER |
| GET | /pilot/groups/:id/report | 파일럿 전용 리포트 | PILOT_MANAGER |
| POST | /pilot/feedback | 오류/이슈 피드백 입력 | 파일럿 대상 EMPLOYEE |
| GET | /pilot/stats | 운영 통계 대시보드 데이터 | PILOT_MANAGER |

## 감사로그
| Method | Path | 설명 | 권한 |
|---|---|---|---|
| GET | /audit/logs | 감사로그 조회(필터: 기간/사용자/액션타입) | SYSTEM_ADMIN |

## 상태 변경 요청 예시

```
POST /attendance/status
{
  "status": "NIGHT_WORK",
  "note": "배포 작업 대응"
}
```

## 야간근무 종료 → 전환 후보 자동 생성 응답 예시

```
POST /night-work/end
{
  "sessionId": "uuid",
  "endedAt": "2026-07-31T02:00:00+09:00"
}

응답:
{
  "success": true,
  "data": {
    "session": { "workedMinutes": 240, "status": "COMPLETED" },
    "leaveConversionCandidate": {
      "id": "uuid",
      "status": "DRAFT",
      "convertedMinutes": 240,
      "leaveType": "ALT_DAY_OFF"
    }
  }
}
```

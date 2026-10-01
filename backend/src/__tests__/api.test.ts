import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../app';
import { prisma } from '../common/prisma';
import { signAccessToken } from '../common/guards/auth';
import { todayDateOnly, realDayWindow } from '../common/attendance-helpers';
import { recordNightWork } from '../common/night-work-helpers';

const app = createApp();

let deptA: string, deptB: string, deptC: string, clientId: string;
let empA: string, empB: string, leadA: string, hr: string, tempUser: string, terminated: string;
let empAToken: string, empBToken: string, leadAToken: string, hrToken: string, tempToken: string;

function tokenFor(id: string, roles: string[], departmentId: string) {
  return signAccessToken({ userId: id, roles, departmentId, tokenVersion: 0 });
}

beforeAll(async () => {
  // 테스트 전용 DB 초기화 (FK 역순)
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE audit_logs, alerts, daily_work_logs, admin_messages, push_subscriptions,
      approval_requests, attendance_correction_requests, leave_conversion_requests, night_work_sessions,
      effort_logs, business_trip_logs, break_sessions, attendance_records, status_change_logs,
      resident_checkins, dauoffice_leave_entries, night_work_mail_reports, leave_balances,
      pilot_feedback, pilot_group_members, pilot_groups, user_roles, users, clients, departments,
      policy_settings, leave_types, roles, dauoffice_tokens, dauoffice_department_overrides
    RESTART IDENTITY CASCADE;
  `);

  const hash = await bcrypt.hash('TestPassword123!', 10);
  const d = async (name: string) => (await prisma.department.create({ data: { name } })).id;
  deptA = await d('T_기술부A'); deptB = await d('T_기술부B'); deptC = await d('T_경영관리부');
  clientId = (await prisma.client.create({ data: { name: 'T_고객사', address: '서울', latitude: 37.5, longitude: 127.0 } })).id;

  const u = async (employeeNo: string, name: string, departmentId: string, opts: any = {}) =>
    (await prisma.user.create({ data: { employeeNo, name, departmentId, workType: 'HQ_FLEX', passwordHash: hash, includedInBoard: true, ...opts } })).id;

  empA = await u('T001', '김테스트A', deptA);
  empB = await u('T002', '김테스트B', deptB);
  leadA = await u('T003', '박팀장A', deptA);
  hr = await u('T004', '이인사', deptC);
  tempUser = await u('T005', '최임시', deptA, { mustChangePassword: true });
  terminated = await u('T006', '정퇴사', deptA, { employmentStatus: 'TERMINATED' });

  empAToken = tokenFor(empA, ['EMPLOYEE'], deptA);
  empBToken = tokenFor(empB, ['EMPLOYEE'], deptB);
  leadAToken = tokenFor(leadA, ['TEAM_LEAD'], deptA);
  hrToken = tokenFor(hr, ['HR_ADMIN'], deptC);
  tempToken = tokenFor(tempUser, ['EMPLOYEE'], deptA);
});

afterAll(async () => { await prisma.$disconnect(); });

async function clockIn(userId: string, hoursAgo = 9) {
  await prisma.attendanceRecord.create({
    data: { userId, workDate: todayDateOnly(), clockInAt: new Date(Date.now() - hoursAgo * 3600_000) },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
describe('C-1 일일업무일지 저장 (수정 전: 전 구간 유실)', () => {
  it('업무일지를 함께 보내면 실제로 저장된다', async () => {
    await clockIn(empA);
    const res = await request(app).post('/api/v1/attendance/clock-out')
      .set('Authorization', `Bearer ${empAToken}`)
      .send({ locationStatus: 'OK', dailyWorkLog: { formType: 'DETAILED', issues: '테스트 이슈', tomorrowPlan: '내일 계획', workContent: '작업내용' } });
    expect(res.status).toBe(200);

    const row = await prisma.dailyWorkLog.findUnique({ where: { userId_workDate: { userId: empA, workDate: todayDateOnly() } } });
    expect(row).not.toBeNull();
    expect(row!.issues).toBe('테스트 이슈');
    expect(row!.tomorrowPlan).toBe('내일 계획');
    expect(row!.formType).toBe('DETAILED');
    expect(row!.totalWorkedMinutes).not.toBeNull(); // 근무시간 스냅샷도 함께 저장
  });

  it('업무일지 없이 퇴근하면 400 WORK_LOG_REQUIRED (근태기록은 미변경)', async () => {
    await clockIn(empB);
    const before = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId: empB, workDate: todayDateOnly() } } });
    const res = await request(app).post('/api/v1/attendance/clock-out')
      .set('Authorization', `Bearer ${empBToken}`).send({ locationStatus: 'OK' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WORK_LOG_REQUIRED');
    const after = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId: empB, workDate: todayDateOnly() } } });
    expect(after!.clockOutAt).toBeNull(); // 검증 실패 시 부분 반영 없음
    expect(before!.clockOutAt).toBeNull();
  });

  it('공백문자만 보낸 이슈/특이사항은 거부된다(trim 검증)', async () => {
    const res = await request(app).post('/api/v1/attendance/clock-out')
      .set('Authorization', `Bearer ${empBToken}`)
      .send({ locationStatus: 'OK', dailyWorkLog: { issues: '   ', tomorrowPlan: '내일' } });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('C-2 async 예외로 프로세스가 죽지 않는다', () => {
  it('비UUID clientId를 보내도 400이고 서버는 계속 살아있다', async () => {
    const res = await request(app).post('/api/v1/attendance/status')
      .set('Authorization', `Bearer ${empAToken}`)
      .send({ status: 'CLIENT_WORK', effort: { clientName: 'T_고객사', clientId: 'not-a-uuid', startTime: '10:00' }, siteType: 'ONSITE', location: { lat: 37.5, lng: 127.0 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('locationAddress에 객체를 보내도 400 (TypeError → 프로세스 종료 방지)', async () => {
    const res = await request(app).post('/api/v1/attendance/clock-in')
      .set('Authorization', `Bearer ${empBToken}`).send({ locationAddress: { a: 1 } });
    expect(res.status).toBe(400);
  });

  it('비UUID recordId로 강제퇴근 요청해도 400', async () => {
    const res = await request(app).post('/api/v1/reports/unresolved-clockouts/abc/force-clock-out')
      .set('Authorization', `Bearer ${hrToken}`).send({ clockOutAt: new Date().toISOString(), reason: 'x' });
    expect(res.status).toBe(400);
  });

  it('존재하지 않는 날짜(9999-99-99) 조회도 400', async () => {
    const res = await request(app).get('/api/v1/dashboard/day?date=9999-99-99').set('Authorization', `Bearer ${hrToken}`);
    expect(res.status).toBe(400);
  });

  it('위 요청들을 모두 처리한 뒤에도 서버가 정상 응답한다(프로세스 생존 확인)', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('잘못된 JSON 본문은 500이 아니라 400', async () => {
    const res = await request(app).post('/api/v1/attendance/status')
      .set('Authorization', `Bearer ${empAToken}`).set('Content-Type', 'application/json').send('{"status": ');
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('H-1 위치확인 "하루 1회 봐주기" NULL 우회 차단', () => {
  it('위치를 아예 안 보내는 등록은 1회만 통과하고 2회차부터 차단된다', async () => {
    const before = await prisma.statusChangeLog.count({ where: { userId: empB } });
    const body = { status: 'CLIENT_WORK', effort: { clientName: 'T_고객사', startTime: '10:00', endTime: '11:00', description: 'x' }, siteType: 'ONSITE' };
    const r1 = await request(app).post('/api/v1/attendance/status').set('Authorization', `Bearer ${empBToken}`).send(body);
    expect(r1.status).toBe(200); // 오늘 첫 실패는 봐준다(설계 의도)

    const r2 = await request(app).post('/api/v1/attendance/status').set('Authorization', `Bearer ${empBToken}`).send(body);
    expect(r2.status).toBe(400);
    expect(r2.body.error.code).toBe('LOCATION_REQUIRED');

    // 3회차도 계속 차단(무한 우회 불가)
    const r3 = await request(app).post('/api/v1/attendance/status').set('Authorization', `Bearer ${empBToken}`).send(body);
    expect(r3.status).toBe(400);
    expect(await prisma.statusChangeLog.count({ where: { userId: empB } })).toBe(before + 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('H-2 위치이탈 제안의 미래 시각 상한', () => {
  it('미래 시각으로 퇴근 제안을 만들 수 없다', async () => {
    const rec = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId: empA, workDate: todayDateOnly() } } });
    await prisma.attendanceRecord.update({ where: { id: rec!.id }, data: { clockOutAt: null, totalWorkedMinutes: null } });
    const res = await request(app).post('/api/v1/attendance/departure-suggest')
      .set('Authorization', `Bearer ${empAToken}`)
      .send({ estimatedClockOutAt: new Date(Date.now() + 24 * 3600_000).toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('OUT_OF_RANGE');
  });

  it('과거 시각 제안은 정상 동작한다(기존 기능 유지)', async () => {
    const res = await request(app).post('/api/v1/attendance/departure-suggest')
      .set('Authorization', `Bearer ${empAToken}`)
      .send({ estimatedClockOutAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('H-3 야간작업 이어받기 오염 방지', () => {
  it('시작시각이 다른 방치 세션은 이어받지 않는다(대체휴무 부풀림 방지)', async () => {
    const stale = await prisma.nightWorkSession.create({
      data: { userId: empA, startedAt: new Date(Date.now() - 5 * 3600_000), status: 'IN_PROGRESS' },
    });
    const startedAt = new Date(Date.now() - 90 * 60_000);
    const endedAt = new Date();
    const r = await recordNightWork(empA, startedAt, endedAt, '새 야간작업');

    expect(r.session.id).not.toBe(stale.id);                  // 새 세션
    expect(r.workedMinutes).toBeLessThanOrEqual(92);          // 5시간이 아니라 1.5시간
    const staleAfter = await prisma.nightWorkSession.findUnique({ where: { id: stale.id } });
    expect(staleAfter!.status).toBe('IN_PROGRESS');           // 방치 세션은 건드리지 않음
  });

  it('같은 세션(시작시각 일치)은 정상적으로 이어받아 완료 처리한다', async () => {
    const startedAt = new Date(Date.now() - 60 * 60_000);
    const s = await prisma.nightWorkSession.create({ data: { userId: empB, startedAt, status: 'IN_PROGRESS' } });
    const r = await recordNightWork(empB, startedAt, new Date(), '완료');
    expect(r.session.id).toBe(s.id);
    expect(r.session.status).toBe('COMPLETED');
    expect(r.workedMinutes).toBeGreaterThan(55);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('H-5 퇴사자 접근 차단', () => {
  it('TERMINATED 계정은 로그인이 403으로 거부된다', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ identifier: 'T006', password: 'TestPassword123!' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });

  it('TERMINATED 계정의 기존 토큰도 API 호출이 거부된다', async () => {
    const t = tokenFor(terminated, ['EMPLOYEE'], deptA);
    const res = await request(app).get('/api/v1/attendance/me').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('ACCOUNT_INACTIVE');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('H-6 JWT_SECRET 하드코딩 폴백 제거', () => {
  it('공개된 기본값으로 서명된 토큰은 더 이상 통과하지 않는다', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ userId: hr, roles: ['SYSTEM_ADMIN'], departmentId: deptC, tokenVersion: 0 }, 'CONFIGURABLE_change_me_in_env');
    const res = await request(app).get('/api/v1/audit/logs').set('Authorization', `Bearer ${forged}`);
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('H-7 재저장이 어제 로그를 덮어쓰지 않는다', () => {
  it('어제 진행중 로그가 있어도 오늘 등록은 새 로그로 남는다', async () => {
    const { start } = realDayWindow(todayDateOnly());
    const yesterdayTs = new Date(start.getTime() - 2 * 3600_000); // 오늘 창 밖

    const oldLog = await prisma.statusChangeLog.create({
      data: { userId: empB, status: 'CLIENT_WORK', changedAt: yesterdayTs, source: 'WEB' },
    });
    // 24시간 이내에 열린 진행중 공수기록 → isSessionResubmit 이 true가 되는 조건
    await prisma.effortLog.create({
      data: { userId: empB, workDate: todayDateOnly(), clientName: 'T_고객사', projectName: '', workType: '기타',
              startTime: new Date(Date.now() - 3 * 3600_000), endTime: null, sourceStatus: 'CLIENT_WORK' },
    });

    const res = await request(app).post('/api/v1/attendance/status')
      .set('Authorization', `Bearer ${empBToken}`)
      .send({ status: 'CLIENT_WORK', note: '오늘 재등록', effort: { clientName: 'T_고객사', startTime: '09:00', endTime: '10:00', description: '오늘 작업' }, siteType: 'ONSITE', location: { lat: 37.5, lng: 127.0 } });
    expect(res.status).toBe(200);

    const oldAfter = await prisma.statusChangeLog.findUnique({ where: { id: oldLog.id } });
    expect(oldAfter!.note).toBeNull();                 // 어제 로그는 그대로
    expect(oldAfter!.changedAt.getTime()).toBe(yesterdayTs.getTime());

    const todayLogs = await prisma.statusChangeLog.findMany({
      where: { userId: empB, changedAt: { gte: start } },
    });
    expect(todayLogs.length).toBeGreaterThan(0);       // 오늘 상태가 실제로 보인다
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('H-8 리포트 부서 스코핑', () => {
  it('TEAM_LEAD는 다른 부서 직원의 타임라인을 볼 수 없다(403)', async () => {
    const res = await request(app).get(`/api/v1/reports/daily-timeline?date=2026-09-30&userId=${empB}`)
      .set('Authorization', `Bearer ${leadAToken}`);
    expect(res.status).toBe(403);
  });

  it('TEAM_LEAD는 같은 부서 직원은 볼 수 있다(200)', async () => {
    const res = await request(app).get(`/api/v1/reports/daily-timeline?date=2026-09-30&userId=${empA}`)
      .set('Authorization', `Bearer ${leadAToken}`);
    expect(res.status).toBe(200);
  });

  it('HR_ADMIN은 전사 조회가 그대로 가능하다(회귀 없음)', async () => {
    const res = await request(app).get(`/api/v1/reports/daily-timeline?date=2026-09-30&userId=${empB}`)
      .set('Authorization', `Bearer ${hrToken}`);
    expect(res.status).toBe(200);
  });

  it('TEAM_LEAD의 내보내기에도 다른 부서 인원이 섞이지 않는다', async () => {
    const res = await request(app).get('/api/v1/reports/attendance-export').set('Authorization', `Bearer ${leadAToken}`);
    expect(res.status).toBe(200);
    const csv = res.text as string;
    expect(csv).toContain('김테스트A');
    expect(csv).not.toContain('김테스트B');
  });

  it('TEAM_LEAD는 다른 부서 직원의 퇴근을 강제확정할 수 없다(403)', async () => {
    const rec = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId: empB, workDate: todayDateOnly() } } });
    if (!rec) return;
    const res = await request(app).post(`/api/v1/reports/unresolved-clockouts/${rec.id}/force-clock-out`)
      .set('Authorization', `Bearer ${leadAToken}`).send({ clockOutAt: new Date().toISOString(), reason: '테스트' });
    expect([403, 400]).toContain(res.status);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('M-6 임시비밀번호 상태 서버 강제', () => {
  it('mustChangePassword 계정은 다른 API가 403 PASSWORD_CHANGE_REQUIRED', async () => {
    const res = await request(app).get('/api/v1/attendance/me').set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('비밀번호 변경/조회 API는 허용된다(사용자가 갇히지 않음)', async () => {
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${tempToken}`);
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('M-12 관리자 강제확정도 점심시간을 공제한다', () => {
  it('9시간 경과 → 480분(9h-1h)으로 확정된다', async () => {
    const clockInAt = new Date(Date.now() - 10 * 3600_000);
    const clockOutAt = new Date(Date.now() - 3600_000); // 9시간 경과
    const rec = await prisma.attendanceRecord.create({
      data: { userId: empA, workDate: new Date(Date.UTC(2026, 0, 2)), clockInAt },
    });
    const res = await request(app).post(`/api/v1/reports/unresolved-clockouts/${rec.id}/force-clock-out`)
      .set('Authorization', `Bearer ${hrToken}`).send({ clockOutAt: clockOutAt.toISOString(), reason: '테스트 확정' });
    expect(res.status).toBe(200);
    expect(res.body.data.totalWorkedMinutes).toBe(480);
  });

  it('미래 시각으로는 확정할 수 없다', async () => {
    const rec = await prisma.attendanceRecord.create({
      data: { userId: empA, workDate: new Date(Date.UTC(2026, 0, 3)), clockInAt: new Date(Date.now() - 5 * 3600_000) },
    });
    const res = await request(app).post(`/api/v1/reports/unresolved-clockouts/${rec.id}/force-clock-out`)
      .set('Authorization', `Bearer ${hrToken}`).send({ clockOutAt: new Date(Date.now() + 3600_000).toISOString(), reason: 'x' });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('M-2 동시성 (휴가전환 중복 신청)', () => {
  it('같은 DRAFT를 동시에 두 번 신청해도 승인요청은 1건만 생성된다', async () => {
    const lt = await prisma.leaveType.create({ data: { code: 'ALT_DAY_OFF', name: '대체휴무' } });
    const draft = await prisma.leaveConversionRequest.create({
      data: { userId: empA, requestedLeaveTypeId: lt.id, convertedMinutes: 60, status: 'DRAFT' },
    });
    const [a, b] = await Promise.all([
      request(app).post('/api/v1/leave-conversion/requests').set('Authorization', `Bearer ${empAToken}`).send({ requestId: draft.id }),
      request(app).post('/api/v1/leave-conversion/requests').set('Authorization', `Bearer ${empAToken}`).send({ requestId: draft.id }),
    ]);
    const okCount = [a, b].filter((r) => r.status === 200).length;
    expect(okCount).toBe(1);
    const approvals = await prisma.approvalRequest.count({ where: { leaveConversionRequestId: draft.id } });
    expect(approvals).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('M-4 인덱스 생성 확인', () => {
  it('핫 쿼리 인덱스가 DB에 실제로 존재한다', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename IN ('status_change_logs','effort_logs','audit_logs','approval_requests')`;
    const names = rows.map((r) => r.indexname).join(',');
    expect(names).toContain('status_change_logs_user_id_changed_at_idx');
    expect(names).toContain('effort_logs_user_id_work_date_idx');
    expect(names).toContain('audit_logs_created_at_idx');
    expect(names).toContain('approval_requests_status_requested_at_idx');
  });
});

import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { prisma } from '../common/prisma';
import { signAccessToken } from '../common/guards/auth';
import { todayDateOnly, realDayWindow, combineDateTime } from '../common/attendance-helpers';
import { ensureDbConstraints } from '../common/ensure-db-constraints';
import { clampRemoteAuditRetentionDays } from '../common/location';

const app = createApp();
let dept: string;
let sysToken = '', empToken = '';
let emp: string, hrUser: string;

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE audit_logs, alerts, daily_work_logs, admin_messages, push_subscriptions,
      approval_requests, attendance_correction_requests, leave_conversion_requests, night_work_sessions,
      effort_logs, business_trip_logs, break_sessions, attendance_records, status_change_logs,
      resident_checkins, dauoffice_leave_entries, night_work_mail_reports, leave_balances,
      pilot_feedback, pilot_group_members, pilot_groups, user_roles, users, clients, departments,
      policy_settings, leave_types, roles, dauoffice_tokens, dauoffice_department_overrides
    RESTART IDENTITY CASCADE;`);
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS policy_settings_key_global_uniq`);
  await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS user_roles_user_role_global_uniq`);
  const hash = await bcrypt.hash('OrigPassword123', 4);
  dept = (await prisma.department.create({ data: { name: 'F_부서' } })).id;
  const roleHr = await prisma.role.create({ data: { code: 'HR_ADMIN', name: 'HR' } });
  await prisma.role.create({ data: { code: 'EMPLOYEE', name: '직원' } });
  emp = (await prisma.user.create({ data: { employeeNo: 'F001', name: '홍길동', passwordHash: hash, departmentId: dept, workType: 'HQ_FLEX' } })).id;
  hrUser = (await prisma.user.create({ data: { employeeNo: 'F002', name: '관리자님', passwordHash: hash, departmentId: dept, workType: 'HQ_FIXED' } })).id;
  await prisma.userRole.create({ data: { userId: hrUser, roleId: roleHr.id } });
  const sys = (await prisma.user.create({ data: { employeeNo: 'F003', name: '시스템', passwordHash: hash, departmentId: dept, workType: 'HQ_FIXED' } })).id;
  sysToken = signAccessToken({ userId: sys, roles: ['SYSTEM_ADMIN'], departmentId: dept, tokenVersion: 0 });
  empToken = signAccessToken({ userId: emp, roles: ['EMPLOYEE'], departmentId: dept, tokenVersion: 0 });
});
afterAll(async () => { await prisma.$disconnect(); });

// ══════════════════════════════════════════════════════════════════════════════
describe('M-7 셀프 비밀번호 재설정 악용 방지', () => {
  it('없는 사번과 이름 불일치가 같은 응답이다(재직자 이름 추측 불가)', async () => {
    const a = await request(app).post('/api/v1/auth/reset-password').send({ employeeNo: 'NOPE999', name: '아무개', newPassword: 'NewPassword123' });
    const b = await request(app).post('/api/v1/auth/reset-password').send({ employeeNo: 'F001', name: '아무개', newPassword: 'NewPassword123' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error).toEqual(b.body.error);
  });

  it('이름을 5번 틀리면 잠기고, 잠긴 동안은 맞는 이름으로도 재설정되지 않는다', async () => {
    for (let i = 0; i < 4; i++) {
      await request(app).post('/api/v1/auth/reset-password').send({ employeeNo: 'F001', name: `틀림${i}`, newPassword: 'NewPassword123' });
    }
    const locked = await request(app).post('/api/v1/auth/reset-password').send({ employeeNo: 'F001', name: '홍길동', newPassword: 'NewPassword123' });
    expect(locked.status).toBe(423);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: emp } });
    expect(await bcrypt.compare('OrigPassword123', u.passwordHash)).toBe(true); // 비밀번호 그대로
    await prisma.user.update({ where: { id: emp }, data: { lockedUntil: null, failedLoginAttempts: 0 } });
  });

  it('관리자(HR_ADMIN) 계정은 이름만 알아도 셀프 재설정할 수 없다(관리자 권한 탈취 차단)', async () => {
    const res = await request(app).post('/api/v1/auth/reset-password').send({ employeeNo: 'F002', name: '관리자님', newPassword: 'Hacked123456' });
    expect(res.status).toBe(403);
    const u = await prisma.user.findUniqueOrThrow({ where: { id: hrUser } });
    expect(await bcrypt.compare('OrigPassword123', u.passwordHash)).toBe(true);
  });

  it('정상 재설정은 동작하고 감사로그가 남는다(기존 기능 유지)', async () => {
    const res = await request(app).post('/api/v1/auth/reset-password').send({ employeeNo: 'F001', name: '홍길동', newPassword: 'NewPassword123' });
    expect(res.status).toBe(200);
    const logs = await prisma.auditLog.findMany({ where: { targetId: emp } });
    expect(logs.map((l) => l.targetType)).toEqual(expect.arrayContaining(['self_service_reset_failed', 'self_service_reset_success']));
  });

  it('SYSTEM_ADMIN이 임시 비밀번호를 발급하면 기존 세션이 끊기고 첫 로그인에서 변경이 강제된다', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: hrUser } });
    const res = await request(app).post(`/api/v1/users/${hrUser}/temporary-password`).set('Authorization', `Bearer ${sysToken}`).send({});
    expect(res.status).toBe(200);
    const pw = res.body.data.temporaryPassword as string;
    expect(pw).toHaveLength(12);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: hrUser } });
    expect(after.mustChangePassword).toBe(true);
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
    const login = await request(app).post('/api/v1/auth/login').send({ identifier: 'F002', password: pw });
    expect(login.status).toBe(200);
  });

  it('일반 직원은 임시 비밀번호를 발급할 수 없다', async () => {
    // 앞 테스트에서 이 직원이 비밀번호를 재설정해 옛 토큰은 폐기됐다(401이 정상) — 최신 tokenVersion으로 다시 발급.
    const v = (await prisma.user.findUniqueOrThrow({ where: { id: emp } })).tokenVersion;
    const t = signAccessToken({ userId: emp, roles: ['EMPLOYEE'], departmentId: dept, tokenVersion: v });
    const stale = await request(app).post(`/api/v1/users/${hrUser}/temporary-password`).set('Authorization', `Bearer ${empToken}`).send({});
    expect(stale.status).toBe(401); // 재설정 전 토큰은 폐기됨
    const res = await request(app).post(`/api/v1/users/${hrUser}/temporary-password`).set('Authorization', `Bearer ${t}`).send({});
    expect(res.status).toBe(403);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('M-14 NULL 복합유니크 구멍 차단', () => {
  it('이미 중복된 전사 정책값이 있어도 최신 1건만 남기고 인덱스를 만든다', async () => {
    await prisma.policySetting.create({ data: { key: 'DUP_KEY', value: 'old', valueType: 'STRING' } });
    await new Promise((r) => setTimeout(r, 20));
    await prisma.policySetting.create({ data: { key: 'DUP_KEY', value: 'new', valueType: 'STRING' } });
    expect(await prisma.policySetting.count({ where: { key: 'DUP_KEY' } })).toBe(2); // 수정 전: 중복 허용

    await ensureDbConstraints();
    const rows = await prisma.policySetting.findMany({ where: { key: 'DUP_KEY' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('new');
  });

  it('이후에는 DB가 전사 정책값 중복 생성을 거부한다', async () => {
    await expect(prisma.policySetting.create({ data: { key: 'DUP_KEY', value: 'x', valueType: 'STRING' } })).rejects.toThrow();
  });

  it('같은 사람에게 같은 전사 역할을 두 번 줄 수 없다', async () => {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'EMPLOYEE' } });
    await prisma.userRole.create({ data: { userId: emp, roleId: role.id } });
    await expect(prisma.userRole.create({ data: { userId: emp, roleId: role.id } })).rejects.toThrow();
  });

  it('부서 범위가 있는 정책값은 부서별로 따로 둘 수 있다(정상 기능 유지)', async () => {
    await prisma.policySetting.create({ data: { key: 'DUP_KEY', value: 'dept', valueType: 'STRING', scopeDepartmentId: dept } });
    expect(await prisma.policySetting.count({ where: { key: 'DUP_KEY' } })).toBe(2);
  });

  it('여러 번 실행해도 안전하다(멱등)', async () => {
    await ensureDbConstraints();
    await ensureDbConstraints();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('M-15 배포 설정', () => {
  it('운영 모드에서 CORS_ORIGIN이 비어 있으면 다른 출처를 허용하지 않는다(fail-closed)', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    delete process.env.CORS_ORIGIN;
    const prodApp = createApp();
    process.env.NODE_ENV = prev;
    const res = await request(prodApp).get('/api/v1/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('개발 모드에서는 기존처럼 허용된다', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBeDefined();
  });

  it('로그인한 사용자는 IP가 아니라 사용자별로 요청 한도를 센다(사무실 NAT 공유 시 429 방지)', async () => {
    const r1 = await request(app).get('/api/v1/health').set('Authorization', `Bearer ${empToken}`);
    const r2 = await request(app).get('/api/v1/health');
    expect(Number(r1.headers['ratelimit-limit'] ?? r1.headers['ratelimit-policy']?.split(';')[0])).toBe(600);
    expect(Number(r2.headers['ratelimit-limit'] ?? r2.headers['ratelimit-policy']?.split(';')[0])).toBe(300);
  });

  it('비밀번호 셀프 재설정에도 IP 제한이 걸려 있다', async () => {
    const res = await request(app).post('/api/v1/auth/reset-password').send({});
    expect(res.headers['ratelimit-limit'] ?? res.headers['ratelimit-policy']).toBeDefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('M-16 재택 좌표 보관기간', () => {
  it('정책값으로 줄일 수는 있지만 180일보다 늘릴 수는 없다', () => {
    expect(clampRemoteAuditRetentionDays(30)).toBe(30);
    expect(clampRemoteAuditRetentionDays(365)).toBe(180);
    expect(clampRemoteAuditRetentionDays(0)).toBe(180);
    expect(clampRemoteAuditRetentionDays(NaN)).toBe(180);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
describe('Low 항목', () => {
  it('L-6 동기화 키: 틀린 키/키 없음은 401, 맞는 키는 통과', async () => {
    process.env.NIGHT_WORK_MAIL_SYNC_KEY = 'sync-secret-123';
    const bad = await request(app).post('/api/v1/night-work-mail/sync').set('x-sync-key', 'sync-secret-12X').send({ items: [] });
    const none = await request(app).post('/api/v1/night-work-mail/sync').send({ items: [] });
    const ok = await request(app).post('/api/v1/night-work-mail/sync').set('x-sync-key', 'sync-secret-123').send({ items: [] });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(ok.status).not.toBe(401);
  });

  it('L-7 tokenVersion이 없는 구버전 토큰은 거부된다', async () => {
    const legacy = jwt.sign({ userId: emp, roles: ['EMPLOYEE'], departmentId: dept }, process.env.JWT_SECRET!);
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${legacy}`);
    expect(res.status).toBe(401);
  });

  it('L-10 새로 만든 기록은 되돌리기 가능, 기존 기록을 갱신한 재저장은 되돌리기 불가', async () => {
    const v = (await prisma.user.findUniqueOrThrow({ where: { id: emp } })).tokenVersion;
    const fresh = signAccessToken({ userId: emp, roles: ['EMPLOYEE'], departmentId: dept, tokenVersion: v });
    await prisma.attendanceRecord.create({ data: { userId: emp, workDate: todayDateOnly(), clockInAt: new Date(Date.now() - 3600_000) } });
    // ① 진행중(종료시간 없음) 고객사작업(원격)을 새로 등록 → 새 로그 → undoable=true
    //    (시간대 제약이 없는 상태를 써서 테스트가 실행 시각에 좌우되지 않게 한다)
    await prisma.client.create({ data: { name: 'F_고객사', address: '-', latitude: 37.5, longitude: 127 } });
    const startHHMM = new Date(Date.now() + 9 * 3600_000 - 30 * 60_000).toISOString().slice(11, 16);
    const body = { status: 'CLIENT_WORK', effort: { clientName: 'F_고객사', startTime: startHHMM, inProgress: true }, siteType: 'REMOTE' };
    const r1 = await request(app).post('/api/v1/attendance/status').set('Authorization', `Bearer ${fresh}`).send(body);
    if (r1.status !== 200) console.log('L10 r1', JSON.stringify(r1.body));
    expect(r1.status).toBe(200);
    expect(r1.body.data.undoable).toBe(true);
    // ② 같은 진행중 세션을 종료시간과 함께 다시 제출(재저장) → 기존 로그 갱신 → undoable=false
    const endHHMM = new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
    const r2 = await request(app).post('/api/v1/attendance/status').set('Authorization', `Bearer ${fresh}`)
      .send({ ...body, effort: { clientName: 'F_고객사', startTime: startHHMM, endTime: endHHMM, description: '원격 점검 완료' } });
    if (r2.status !== 200) console.log('L10 r2', JSON.stringify(r2.body));
    expect(r2.status).toBe(200);
    expect(r2.body.data.statusLog.id).toBe(r1.body.data.statusLog.id); // 같은 로그를 갱신
    expect(r2.body.data.undoable).toBe(false);
  });

  it('L-12 활동 근거 없는 18시 신청은 자동승인되지 않는다(사람 확인)', async () => {
    const u = await prisma.user.create({ data: { employeeNo: 'F010', name: '자동승인테스트', passwordHash: 'x', departmentId: dept, workType: 'HQ_FLEX' } });
    const t = signAccessToken({ userId: u.id, roles: ['EMPLOYEE'], departmentId: dept, tokenVersion: 0 });
    const wd = new Date(todayDateOnly().getTime() - 2 * 86400_000);
    const rec = await prisma.attendanceRecord.create({ data: { userId: u.id, workDate: wd, clockInAt: combineDateTime(wd, '08:30') } });
    // 마지막 활동이 13:00 → 18:00 신청은 5시간 공백
    await prisma.statusChangeLog.create({ data: { userId: u.id, status: 'HQ_WORKING', source: 'WEB', changedAt: combineDateTime(wd, '13:00') } });
    const res = await request(app).post('/api/v1/attendance-correction/requests').set('Authorization', `Bearer ${t}`)
      .send({ attendanceRecordId: rec.id, proposedClockOutAt: combineDateTime(wd, '18:00').toISOString(), reason: '퇴근 버튼 누르는 걸 깜빡했습니다.' });
    expect(res.status).toBe(200);
    expect(res.body.data.autoApproved).toBe(false);
  });

  it('L-12 18시 근처까지 활동이 있으면 기존처럼 자동승인된다(기능 유지)', async () => {
    const u = await prisma.user.create({ data: { employeeNo: 'F011', name: '자동승인정상', passwordHash: 'x', departmentId: dept, workType: 'HQ_FLEX' } });
    const t = signAccessToken({ userId: u.id, roles: ['EMPLOYEE'], departmentId: dept, tokenVersion: 0 });
    const wd = new Date(todayDateOnly().getTime() - 2 * 86400_000);
    const rec = await prisma.attendanceRecord.create({ data: { userId: u.id, workDate: wd, clockInAt: combineDateTime(wd, '08:30') } });
    await prisma.statusChangeLog.create({ data: { userId: u.id, status: 'HQ_WORKING', source: 'WEB', changedAt: combineDateTime(wd, '17:10') } });
    const res = await request(app).post('/api/v1/attendance-correction/requests').set('Authorization', `Bearer ${t}`)
      .send({ attendanceRecordId: rec.id, proposedClockOutAt: combineDateTime(wd, '18:00').toISOString(), reason: '퇴근 버튼 누르는 걸 깜빡했습니다.' });
    expect(res.status).toBe(200);
    expect(res.body.data.autoApproved).toBe(true);
  });

  it('L-9 알림: 오늘 근무일 기록을 기준으로 계산된다(새벽 미출근 오탐 없음)', async () => {
    const res = await request(app).get('/api/v1/alerts').set('Authorization', `Bearer ${signAccessToken({ userId: hrUser, roles: ['HR_ADMIN'], departmentId: dept, tokenVersion: (await prisma.user.findUniqueOrThrow({ where: { id: hrUser } })).tokenVersion })}`);
    // 임시비번 상태라 403이 정상 — mustChangePassword 해제 후 재확인
    if (res.status === 403) {
      await prisma.user.update({ where: { id: hrUser }, data: { mustChangePassword: false } });
    }
    const hrTok = signAccessToken({ userId: hrUser, roles: ['HR_ADMIN'], departmentId: dept, tokenVersion: (await prisma.user.findUniqueOrThrow({ where: { id: hrUser } })).tokenVersion });
    const res2 = await request(app).get('/api/v1/alerts').set('Authorization', `Bearer ${hrTok}`);
    expect(res2.status).toBe(200);
    const kstHour = (new Date().getUTCHours() + 9) % 24;
    const noClockIn = (res2.body.data as { ruleCode: string }[]).filter((a) => a.ruleCode === 'NO_CLOCK_IN');
    if (kstHour < 12) expect(noClockIn).toHaveLength(0);
  });
});

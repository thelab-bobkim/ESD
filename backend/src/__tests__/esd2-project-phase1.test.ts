// ══════════════════════════════════════════════════════════════════════════════
// ESD 2.0 Phase 1 독립 검증 테스트 (Claude 작성)
//
// 사용자 요청사항 12 "반드시 검증할 통합 시나리오"를 실제로 실행해서 확인한다.
// 특히 아래 세 가지 IDOR/권한 거부 시나리오와, 레거시 자유문자 EffortLog 호환성을 다룬다.
//   - 직원이 자신이 참여하지 않은 프로젝트의 projectId를 입력 → 서버가 거부해야 한다.
//   - 다른 프로젝트의 taskId를 입력 → 서버가 거부해야 한다.
//   - Task 담당자가 아닌 직원이 Task 난이도를 변경 → 서버가 거부해야 한다.
//   - 과거 자유문자 방식 EffortLog가 정상적으로 조회되는지.
//   - projectId가 있으면 projectName이 클라이언트 입력이 아닌 DB 정식 명칭으로 저장되는지.
// ══════════════════════════════════════════════════════════════════════════════
import request from 'supertest';
import { createApp } from '../app';
import { prisma } from '../common/prisma';
import { signAccessToken } from '../common/guards/auth';
import { todayDateOnly, isWeekendForWorkDate } from '../common/attendance-helpers';

const app = createApp();
// attendance.routes.ts의 "주말엔 주말작업만" 게이트 때문에, 실행 시점이 실제로 주말(KST)이면
// CLIENT_WORK가 아니라 WEEKEND_WORK로 등록해야 한다 — 테스트가 실행 요일에 영향받지 않도록 한다.
const EFFORT_STATUS = isWeekendForWorkDate(todayDateOnly()) ? 'WEEKEND_WORK' : 'CLIENT_WORK';

// 2026-10-01 수정(실제 jest 실행으로 발견): CLIENT_WORK/WEEKEND_WORK는 attendance.routes.ts의
// REQUIRE_SITE_TYPE_STATUSES에 포함되어 있어 siteType(원격/현장) 없이는 SITE_TYPE_REQUIRED(400)로
// 거부된다 — 이 검증은 ESD2.0과 무관하게 a10b7c8 원본에 이미 있던 요구사항인데, 이 테스트 작성
// 당시 누락했었다. IDOR 검증 자체와는 무관한 선행 검증이므로, 위치대조까지 건드리지 않는
// 'REMOTE'를 넣어 그 관문만 통과시킨다(siteType!=='REMOTE'일 때만 위치대조 로직이 도는 것도
// 코드로 확인함 — attendance.routes.ts의 LOCATION_CHECK_ELIGIBLE_STATUSES 블록 참고).
let dept: string;
let projectA: string, projectB: string;
let taskInA: string, taskInB: string;
let memberToken: string, memberId: string;
let outsiderToken: string, outsiderId: string;
let otherAssigneeToken: string, otherAssigneeId: string;

beforeAll(async () => {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE project_tasks, project_members, projects, effort_logs, status_change_logs,
      attendance_records, users, departments, clients RESTART IDENTITY CASCADE;
  `);
  dept = (await prisma.department.create({ data: { name: 'ESD2_부서' } })).id;

  const member = await prisma.user.create({ data: { employeeNo: 'E2_001', name: 'ESD2참여자', departmentId: dept, workType: 'HQ_FLEX', passwordHash: 'x' } });
  memberId = member.id;
  memberToken = signAccessToken({ userId: member.id, roles: ['EMPLOYEE'], departmentId: dept, tokenVersion: 0 });

  const outsider = await prisma.user.create({ data: { employeeNo: 'E2_002', name: 'ESD2비참여자', departmentId: dept, workType: 'HQ_FLEX', passwordHash: 'x' } });
  outsiderId = outsider.id;
  outsiderToken = signAccessToken({ userId: outsider.id, roles: ['EMPLOYEE'], departmentId: dept, tokenVersion: 0 });

  const otherAssignee = await prisma.user.create({ data: { employeeNo: 'E2_003', name: 'ESD2다른담당자', departmentId: dept, workType: 'HQ_FLEX', passwordHash: 'x' } });
  otherAssigneeId = otherAssignee.id;
  otherAssigneeToken = signAccessToken({ userId: otherAssignee.id, roles: ['EMPLOYEE'], departmentId: dept, tokenVersion: 0 });

  const admin = await prisma.user.create({ data: { employeeNo: 'E2_ADMIN', name: 'ESD2관리자', departmentId: dept, workType: 'HQ_FIXED', passwordHash: 'x' } });

  const pA = await prisma.project.create({ data: { code: 'E2-A', name: 'ESD2 테스트 프로젝트A(정식명칭)', createdByUserId: admin.id, status: 'ACTIVE' } });
  const pB = await prisma.project.create({ data: { code: 'E2-B', name: 'ESD2 테스트 프로젝트B', createdByUserId: admin.id, status: 'ACTIVE' } });
  projectA = pA.id; projectB = pB.id;
  await prisma.projectMember.create({ data: { projectId: projectA, userId: memberId } });
  await prisma.projectMember.create({ data: { projectId: projectB, userId: otherAssigneeId } });

  const tA = await prisma.projectTask.create({ data: { projectId: projectA, title: 'A프로젝트 Task', assigneeId: otherAssigneeId, difficulty: 2 } });
  const tB = await prisma.projectTask.create({ data: { projectId: projectB, title: 'B프로젝트 Task', difficulty: 2 } });
  taskInA = tA.id; taskInB = tB.id;
});

afterAll(async () => { await prisma.$disconnect(); });

describe('[ESD2.0 독립검증] 공수 등록 시 프로젝트/Task IDOR 방지', () => {
  it('본인이 참여하지 않은 프로젝트의 projectId로 공수를 등록하면 거부된다', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/status')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ status: EFFORT_STATUS, siteType: 'REMOTE', effort: { clientName: '테스트고객사', projectId: projectB, startTime: '10:00', endTime: '11:00' } , location: { lat: 37.5, lng: 127.0 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PROJECT');
  });

  it('참여 중인 프로젝트라도, 그 프로젝트에 속하지 않은(다른 프로젝트의) taskId를 넣으면 거부된다', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/status')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ status: EFFORT_STATUS, siteType: 'REMOTE', effort: { clientName: '테스트고객사', projectId: projectA, taskId: taskInB, startTime: '10:00', endTime: '11:00' } , location: { lat: 37.5, lng: 127.0 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PROJECT_TASK');
  });

  it('projectId 없이 taskId만 보내면 거부된다', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/status')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ status: EFFORT_STATUS, siteType: 'REMOTE', effort: { clientName: '테스트고객사', taskId: taskInA, startTime: '10:00', endTime: '11:00' } , location: { lat: 37.5, lng: 127.0 } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PROJECT_TASK');
  });

  it('정상적으로 참여 중인 프로젝트+그 프로젝트의 Task로 등록하면 성공하고, projectName은 클라이언트가 보낸 값이 아니라 DB 정식 명칭으로 저장된다', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/status')
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ status: EFFORT_STATUS, siteType: 'REMOTE', effort: { clientName: '테스트고객사', projectId: projectA, taskId: taskInA, projectName: '직원이_임의로_써낸_가짜_이름', startTime: '10:00', endTime: '11:00' } , location: { lat: 37.5, lng: 127.0 } });
    expect(res.status).toBe(200);
    const saved = await prisma.effortLog.findFirst({ where: { userId: memberId, projectId: projectA }, orderBy: { createdAt: 'desc' } });
    expect(saved).not.toBeNull();
    expect(saved!.projectName).toBe('ESD2 테스트 프로젝트A(정식명칭)'); // 클라이언트 입력 문자열이 아니라 DB 정식명칭
    expect(saved!.taskId).toBe(taskInA);
  });
});

describe('[ESD2.0 독립검증] Task 평가근거 필드는 담당자 본인도 변경 못하고, 관리자만 가능하다', () => {
  it('Task 담당자가 아닌 직원이 난이도 변경을 시도하면 거부된다', async () => {
    const res = await request(app)
      .patch(`/api/v1/projects/tasks/${taskInA}`)
      .set('Authorization', `Bearer ${memberToken}`) // memberId는 taskInA 담당자가 아님(otherAssigneeId가 담당자)
      .send({ difficulty: 5 });
    expect(res.status).toBe(403);
  });

  it('Task 담당자 본인이어도 난이도(평가근거 필드)는 바뀌지 않고, 허용된 status만 반영된다', async () => {
    const res = await request(app)
      .patch(`/api/v1/projects/tasks/${taskInA}`)
      .set('Authorization', `Bearer ${otherAssigneeToken}`) // 실제 담당자
      .send({ status: 'IN_PROGRESS', difficulty: 5, plannedMinutes: 99999 });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('IN_PROGRESS');
    expect(res.body.data.difficulty).toBe(2); // 원래 값 그대로 — 직원이 보낸 5는 무시됨
    expect(res.body.data.plannedMinutes).toBeNull();
  });

  it('완전히 무관한 직원은 본인 소속 프로젝트가 아닌 Task의 상태조차 바꿀 수 없다', async () => {
    const res = await request(app)
      .patch(`/api/v1/projects/tasks/${taskInA}`)
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ status: 'DONE' });
    expect(res.status).toBe(403);
  });
});

describe('[ESD2.0 독립검증] 레거시 자유문자 EffortLog 호환성', () => {
  it('projectId/taskId 없이(자유문자만으로) 등록한 과거 방식 공수기록도 그대로 생성·조회된다', async () => {
    const res = await request(app)
      .post('/api/v1/attendance/status')
      .set('Authorization', `Bearer ${outsiderToken}`)
      .send({ status: EFFORT_STATUS, siteType: 'REMOTE', effort: { clientName: '레거시고객사', projectName: '레거시 자유입력 프로젝트명', startTime: '09:00', endTime: '10:00' } , location: { lat: 37.5, lng: 127.0 } });
    expect(res.status).toBe(200);
    const saved = await prisma.effortLog.findFirst({ where: { userId: outsiderId, clientName: '레거시고객사' } });
    expect(saved).not.toBeNull();
    expect(saved!.projectName).toBe('레거시 자유입력 프로젝트명'); // 구조화 FK가 없으면 클라이언트 입력 그대로 유지(호환)
    expect(saved!.projectId).toBeNull();
    expect(saved!.taskId).toBeNull();
  });
});

describe('[ESD2.0 독립검증] 직원 개인 성과 화면은 로그인만 하면(관리자 권한 없이) 본인 데이터를 볼 수 있다', () => {
  it('GET /projects/me/performance는 EMPLOYEE 권한으로도 200을 반환한다', async () => {
    const res = await request(app)
      .get('/api/v1/projects/me/performance')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('projectCount');
    expect(res.body.data).not.toHaveProperty('rows'); // 관리자용 전체 목록이 아니라 본인 데이터만
  });

  it('GET /projects/performance/summary(관리자 전용)는 일반 직원에게는 403이다', async () => {
    const res = await request(app)
      .get('/api/v1/projects/performance/summary')
      .set('Authorization', `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });
});

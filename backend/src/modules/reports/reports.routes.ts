import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { realDayWindow, computeTimelineSegments, computeClockInMismatch } from '../../common/attendance-helpers';
import { recordAuditLog } from '../../common/audit';
import { getPolicyNumber } from '../../common/policy-engine/policy-engine';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireRole('HR_ADMIN', 'SYSTEM_ADMIN', 'TEAM_LEAD'));

// 2026-09-18: CSV로 다운받은 엑셀 파일에서 한글(이름 등)이 "源?蟲?" 식으로 깨져 보인다는 문의로
// 원인 확인 — 내용 자체는 UTF-8로 정상 생성되고 있었지만, 파일 맨 앞에 BOM(Byte Order Mark)이
// 없어서 한글 Windows 엑셀이 파일을 시스템 기본 코드페이지(CP949)로 잘못 해석해 벌어진 문제였다
// (인코딩 문제일 뿐 실제 데이터 자체는 처음부터 정상 저장돼 있었음). res.send() 쪽에서 BOM을 붙인다.
// 필드 이스케이프도 함께 정리: 기존에는 JSON.stringify로 감쌌는데, 이는 큰따옴표를 백슬래시(\")로
// 이스케이프해서 CSV 표준(큰따옴표를 두 번 반복 "")과 달라 엑셀이 잘못 해석할 여지가 있었다
// (예: 비고란에 큰따옴표나 줄바꿈이 들어간 경우). RFC4180 방식으로 교체.
function csvField(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCSV(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h])).join(','));
  }
  return lines.join('\n');
}

// 엑셀(특히 한글 Windows)이 BOM 없는 UTF-8 CSV를 CP949로 오인해서 한글이 깨지는 것을 막기 위한
// BOM. res.send()에 이 값 + toCSV(...) 결과를 그대로 넘긴다.
const CSV_BOM = '﻿';

const rangeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

/**
 * 근무시간 누계(주/월 등) — 주52시간제 준수 여부를 확인하기 위한 기간별 실근무시간 합계.
 * from/to는 호출하는 쪽에서 "이번 주", "이번 달" 등으로 계산해서 넘긴다(YYYY-MM-DD).
 */
reportsRouter.get('/worktime-summary', async (req, res) => {
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'from, to가 필요합니다(YYYY-MM-DD).' } });
  }
  const { from, to } = parsed.data;
  const records = await prisma.attendanceRecord.findMany({
    // 2026-09-04: attendance-detail과 동일하게 표시대상(includedInBoard)만 집계한다.
    where: { workDate: { gte: new Date(from), lte: new Date(to) }, user: { includedInBoard: true } },
    include: { user: { include: { department: true } } },
  });

  const byUser = new Map<string, { userId: string; name: string; employeeNo: string; department: string; totalMinutes: number; days: number }>();
  for (const r of records) {
    if (!r.totalWorkedMinutes) continue; // 퇴근 처리(확정)된 날만 집계
    const key = r.userId;
    const cur = byUser.get(key) ?? {
      userId: r.userId,
      name: r.user.name,
      employeeNo: r.user.employeeNo,
      department: r.user.department.name,
      totalMinutes: 0,
      days: 0,
    };
    cur.totalMinutes += r.totalWorkedMinutes;
    cur.days += 1;
    byUser.set(key, cur);
  }

  const rows = Array.from(byUser.values()).sort((a, b) => b.totalMinutes - a.totalMinutes);
  return res.json({ success: true, data: { from, to, rows } });
});

/**
 * 프로젝트/고객사별 공수(工數) 집계 — 완료된(작업완료 시간이 입력된) 공수기록만 합산한다.
 */
reportsRouter.get('/effort-summary', async (req, res) => {
  const parsed = rangeSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'from, to가 필요합니다(YYYY-MM-DD).' } });
  }
  const { from, to } = parsed.data;
  const workType = typeof req.query.workType === 'string' && req.query.workType !== 'ALL' ? req.query.workType : undefined;

  const fetchLogs = (fromD: Date, toD: Date) =>
    prisma.effortLog.findMany({
      where: { workDate: { gte: fromD, lte: toD }, minutes: { not: null }, ...(workType ? { workType } : {}) },
      // 2026-09-14: "엔지니어별" 관점 드롭다운을 실제 기술부 소속만으로 좁히려면(프론트의
      // classifyDeptGroup) 부서명이 필요해서 department도 같이 내려준다.
      include: { user: { select: { name: true, employeeNo: true, department: { select: { name: true } } } } },
      orderBy: { workDate: 'desc' },
    });

  const fromDate = new Date(from);
  const toDate = new Date(to);
  // 고객사명이 없는 기록(사내 업무일지 등)은 이 "고객사별" 리포트에서 제외한다 —
  // 아직 전사 도입 전이라 "(미지정)" 묶음이 관리적으로 의미가 없기 때문.
  const logs = (await fetchLogs(fromDate, toDate)).filter((l) => l.clientName && l.clientName.trim());

  // 전기간(직전 동일 길이 구간) 대비 증감을 보여주기 위해 이전 구간도 같이 집계한다.
  const periodMs = toDate.getTime() - fromDate.getTime() + 24 * 60 * 60 * 1000;
  const prevTo = new Date(fromDate.getTime() - 24 * 60 * 60 * 1000);
  const prevFrom = new Date(prevTo.getTime() - periodMs + 24 * 60 * 60 * 1000);
  const prevLogs = (await fetchLogs(prevFrom, prevTo)).filter((l) => l.clientName && l.clientName.trim());
  const prevByClient = new Map<string, number>();
  for (const l of prevLogs) {
    const key = l.clientName;
    prevByClient.set(key, (prevByClient.get(key) ?? 0) + (l.minutes ?? 0));
  }

  interface ProjectGroup {
    projectName: string;
    clientName: string;
    totalMinutes: number;
    workTypes: Set<string>;
    byUser: Map<string, { userId: string; name: string; department: string; minutes: number }>;
  }
  const byProject = new Map<string, ProjectGroup>();
  for (const l of logs) {
    const key = `${l.clientName}::${l.projectName}`;
    const group = byProject.get(key) ?? { projectName: l.projectName || '(미지정)', clientName: l.clientName || '(미지정)', totalMinutes: 0, workTypes: new Set<string>(), byUser: new Map() };
    group.totalMinutes += l.minutes ?? 0;
    group.workTypes.add(l.workType);
    const u = group.byUser.get(l.userId) ?? { userId: l.userId, name: l.user.name, department: l.user.department.name, minutes: 0 };
    u.minutes += l.minutes ?? 0;
    group.byUser.set(l.userId, u);
    byProject.set(key, group);
  }

  const projectRows = Array.from(byProject.values()).map((g) => ({
    projectName: g.projectName,
    clientName: g.clientName,
    totalMinutes: g.totalMinutes,
    workTypes: Array.from(g.workTypes),
    byUser: Array.from(g.byUser.values()).sort((a, b) => b.minutes - a.minutes),
  }));

  // 고객사 단위로 다시 묶는다 — 관리 판단은 프로젝트 단위가 아니라 "이 고객사에 총 몇 시간 썼는지"가 기준이라서.
  interface ClientGroup {
    clientName: string;
    totalMinutes: number;
    projects: typeof projectRows;
    engineerMinutes: Map<string, { userId: string; name: string; department: string; minutes: number }>;
    workTypeMinutes: Map<string, number>;
  }
  const byClient = new Map<string, ClientGroup>();
  for (const p of projectRows) {
    const group = byClient.get(p.clientName) ?? {
      clientName: p.clientName, totalMinutes: 0, projects: [] as typeof projectRows, engineerMinutes: new Map(), workTypeMinutes: new Map(),
    };
    group.totalMinutes += p.totalMinutes;
    group.projects.push(p);
    for (const u of p.byUser) {
      const cur = group.engineerMinutes.get(u.userId) ?? { userId: u.userId, name: u.name, department: u.department, minutes: 0 };
      cur.minutes += u.minutes;
      group.engineerMinutes.set(u.userId, cur);
    }
    for (const wt of p.workTypes) {
      // workTypes는 프로젝트 안에 섞인 유형 목록이라, 프로젝트 총 시간을 유형 수로 나눠 근사치로 배분한다.
      group.workTypeMinutes.set(wt, (group.workTypeMinutes.get(wt) ?? 0) + p.totalMinutes / p.workTypes.length);
    }
    byClient.set(p.clientName, group);
  }

  const clients = Array.from(byClient.values())
    .map((g) => {
      const engineers = Array.from(g.engineerMinutes.values()).sort((a, b) => b.minutes - a.minutes);
      const topEngineer = engineers[0] ?? null;
      const concentrationPct = topEngineer && g.totalMinutes > 0 ? Math.round((topEngineer.minutes / g.totalMinutes) * 100) : 0;
      const topWorkType = Array.from(g.workTypeMinutes.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const prevMinutes = prevByClient.get(g.clientName) ?? 0;
      const trendPct = prevMinutes > 0 ? Math.round(((g.totalMinutes - prevMinutes) / prevMinutes) * 100) : null;
      return {
        clientName: g.clientName,
        totalMinutes: g.totalMinutes,
        projectCount: g.projects.length,
        engineerCount: engineers.length,
        topEngineerName: topEngineer?.name ?? null,
        concentrationPct, // 한 엔지니어가 이 고객사 공수의 몇 %를 담당하는지(편중도)
        topWorkType,
        trendPct, // 직전 동일기간 대비 증감률(%). 이전 데이터 없으면 null
        projects: g.projects.sort((a, b) => b.totalMinutes - a.totalMinutes),
      };
    })
    .sort((a, b) => b.totalMinutes - a.totalMinutes);

  return res.json({ success: true, data: { from, to, clients } });
});

/**
 * 2026-09-14: "엔지니어별 대상 목록은 출퇴근·근로시간의 '기술부만 보기'에 나오는 인원 전체를
 * 항상 보여줘야 한다"는 요청 — effort-summary는 이 기간에 공수기록이 실제로 있는 사람만 내려주기
 * 때문에, 기록이 아직 없는 엔지니어는 드롭다운에서 통째로 빠지는 문제가 있었다. attendance-detail과
 * 동일한 재직중 표시대상(includedInBoard) 전체 명단에서 이름/부서만 내려주고, 기술부 여부 판별
 * (classifyDeptGroup)과 기간별 투입시간 합산은 프론트에서 처리한다.
 */
reportsRouter.get('/employee-roster', async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { includedInBoard: true, employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
    select: { id: true, name: true, department: { select: { name: true } } },
    orderBy: { name: 'asc' },
  });
  const rows = users.map((u) => ({ userId: u.id, name: u.name, department: u.department.name }));
  return res.json({ success: true, data: rows });
});

const KST_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
function kstWeekday(d: Date): string {
  return KST_WEEKDAYS[new Date(d.getTime() + 9 * 60 * 60 * 1000).getUTCDay()];
}
function kstHHmm(d: Date): string {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return `${String(kst.getUTCHours()).padStart(2, '0')}:${String(kst.getUTCMinutes()).padStart(2, '0')}`;
}

const timelineSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  scope: z.enum(['client', 'engineer']),
  value: z.string().min(1),
});

/**
 * 2026-09-14: "고객사별 공수관리가 관리자 입장에서 활용 가능한 데이터로 안 보인다"는 의견 반영 —
 * 고객사 또는 엔지니어 한 명을 골랐을 때, 그 대상이 이 기간에 실제로 수행한 개별 공수기록을
 * 날짜/시간 순서대로 그대로 내려준다(effort-summary는 프로젝트·엔지니어 단위로 이미 합산된
 * 값만 주므로, 시계열 화면에는 이 원본 단위 데이터가 필요하다). effort-summary와 동일하게
 * 완료된(작업완료 시간이 입력된) 기록만, 고객사명이 있는 기록만 대상으로 한다.
 */
reportsRouter.get('/effort-timeline', async (req, res) => {
  const parsed = timelineSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'from, to, scope, value가 필요합니다.' } });
  }
  const { from, to, scope, value } = parsed.data;
  const workType = typeof req.query.workType === 'string' && req.query.workType !== 'ALL' ? req.query.workType : undefined;

  const logs = await prisma.effortLog.findMany({
    where: {
      workDate: { gte: new Date(from), lte: new Date(to) },
      minutes: { not: null },
      ...(workType ? { workType } : {}),
      ...(scope === 'client' ? { clientName: value } : { userId: value }),
    },
    include: { user: { select: { name: true } } },
    orderBy: [{ workDate: 'asc' }, { startTime: 'asc' }],
  });

  const entries = logs
    .filter((l) => l.clientName && l.clientName.trim())
    .map((l) => ({
      id: l.id,
      workDate: l.workDate.toISOString().slice(0, 10),
      day: kstWeekday(l.workDate),
      clientName: l.clientName,
      projectName: l.projectName,
      workType: l.workType,
      startLabel: kstHHmm(l.startTime),
      endLabel: l.endTime ? kstHHmm(l.endTime) : null,
      minutes: l.minutes ?? 0,
      description: l.description ?? '',
      userId: l.userId,
      userName: l.user.name,
    }));

  return res.json({ success: true, data: { from, to, scope, value, entries } });
});

reportsRouter.get('/effort-export', async (req, res) => {
  const logs = await prisma.effortLog.findMany({
    include: { user: { select: { name: true, employeeNo: true } } },
    orderBy: { workDate: 'desc' },
    take: 2000,
  });
  const rows = logs.map((l) => ({
    employeeNo: l.user.employeeNo,
    name: l.user.name,
    workDate: l.workDate.toISOString().slice(0, 10),
    clientName: l.clientName,
    projectName: l.projectName,
    workType: l.workType,
    startTime: l.startTime.toISOString(),
    endTime: l.endTime?.toISOString() ?? '',
    minutes: l.minutes ?? '',
    description: l.description ?? '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="effort-export.csv"');
  return res.send(CSV_BOM + toCSV(rows));
});

reportsRouter.get('/attendance-export', async (req, res) => {
  const records = await prisma.attendanceRecord.findMany({
    where: { user: { includedInBoard: true } },
    include: { user: { select: { name: true, employeeNo: true } } },
    orderBy: { workDate: 'desc' },
    take: 1000,
  });
  const rows = records.map((r) => ({
    employeeNo: r.user.employeeNo,
    name: r.user.name,
    workDate: r.workDate.toISOString().slice(0, 10),
    clockInAt: r.clockInAt?.toISOString() ?? '',
    clockOutAt: r.clockOutAt?.toISOString() ?? '',
    totalWorkedMinutes: r.totalWorkedMinutes ?? '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance-export.csv"');
  return res.send(CSV_BOM + toCSV(rows));
});

reportsRouter.get('/night-work-export', async (req, res) => {
  const sessions = await prisma.nightWorkSession.findMany({
    where: { user: { includedInBoard: true } },
    include: { user: { select: { name: true, employeeNo: true } }, leaveConversionRequest: true },
    orderBy: { startedAt: 'desc' },
    take: 1000,
  });
  const rows = sessions.map((s) => ({
    employeeNo: s.user.employeeNo,
    name: s.user.name,
    startedAt: s.startedAt.toISOString(),
    endedAt: s.endedAt?.toISOString() ?? '',
    workedMinutes: s.workedMinutes ?? '',
    conversionStatus: s.leaveConversionRequest?.status ?? 'NONE',
    convertedMinutes: s.leaveConversionRequest?.convertedMinutes ?? '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="night-work-export.csv"');
  return res.send(CSV_BOM + toCSV(rows));
});

const daySchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/**
 * 하루 단위 출퇴근 상세 — worktime-summary와 달리 "퇴근 전(진행중)"인 사람도 포함해서
 * 출근시각/퇴근시각을 있는 그대로 보여준다. "오늘 출퇴근 현황을 매일 확인"하는 용도.
 */
reportsRouter.get('/attendance-detail', async (req, res) => {
  const parsed = daySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'date(YYYY-MM-DD)가 필요합니다.' } });
  }
  const workDate = new Date(`${parsed.data.date}T00:00:00.000Z`);

  // 2026-09-04: 예전엔 그날 출근기록(attendanceRecord)이 있는 사람만 조회했는데, 그러면 그날
  // 앱을 아예 안 켠(출근조차 안 찍은) 직원은 목록에서 통째로 빠져서 "이 사람 오늘 출근했나?"를
  // 확인할 방법이 없었다. 지금은 표시대상(includedInBoard) 전원을 기준으로 조회하고, 그날
  // 기록이 없으면 출근/퇴근을 전부 null로 둔 채 "미출근" 상태로 보여준다(회사 요청 — 모든
  // 대상자가 항상 보이고, 앱을 안 쓰는 사람도 바로 드러나야 함).
  const scopedUsers = await prisma.user.findMany({
    where: { includedInBoard: true, employmentStatus: 'ACTIVE', name: { not: { startsWith: 'SAMPLE_' } } },
    include: { department: true },
    orderBy: [{ department: { name: 'asc' } }, { name: 'asc' }],
  });
  const userIds = scopedUsers.map((u) => u.id);

  const records = await prisma.attendanceRecord.findMany({
    where: { workDate, userId: { in: userIds } },
  });
  const recordByUser = new Map<string, (typeof records)[number]>();
  for (const r of records) recordByUser.set(r.userId, r);

  // 이 날짜의 이동시간(자동추정 포함)을 각 직원별로 계산하기 위해, 전 직원의 상태변경 로그를
  // 한 번에 불러와서 userId로 묶는다(직원마다 따로 조회하지 않도록).
  const { start: dayStart, end: dayEnd } = realDayWindow(workDate);
  const dayLogs = await prisma.statusChangeLog.findMany({
    where: { changedAt: { gte: dayStart, lt: dayEnd }, userId: { in: userIds } },
    orderBy: { changedAt: 'asc' },
    select: { userId: true, status: true, changedAt: true, note: true },
  });
  const logsByUser = new Map<string, typeof dayLogs>();
  for (const log of dayLogs) {
    const arr = logsByUser.get(log.userId);
    if (arr) arr.push(log);
    else logsByUser.set(log.userId, [log]);
  }
  const defaultTravelMinutes = await getPolicyNumber('DEFAULT_TRAVEL_MINUTES', 30);

  const rows = scopedUsers.map((u) => {
    const r = recordByUser.get(u.id) ?? null;
    const userLogs = logsByUser.get(u.id) ?? [];
    const { totalTravelMinutes, hasEstimatedTravel } = computeTimelineSegments(
      userLogs,
      r?.clockOutAt ?? null,
      defaultTravelMinutes
    );
    // 2026-09-04: 출근을 안 찍은 직원이 "지금 어디서 뭘 하고 있는지" 관리자가 이 화면에서 바로
    // 알 수 있도록, 그날 등록한 상태변경 로그(userLogs, changedAt 오름차순) 중 가장 최근 것을
    // 함께 내려준다. "이동중"처럼 정식 출근으로 안 이어지는 상태도 여기 잡힌다(attendance.routes.ts의
    // WORK_START_STATUSES에 없는 상태) — 즉 미출근이어도 최근 상태가 있을 수 있다.
    const lastLog = userLogs.length > 0 ? userLogs[userLogs.length - 1] : null;
    return {
      recordId: r?.id ?? null,
      userId: u.id,
      employeeNo: u.employeeNo,
      name: u.name,
      department: u.department.name,
      clockInAt: r?.clockInAt ?? null,
      clockOutAt: r?.clockOutAt ?? null,
      clockOutLocation: r?.clockOutLocation ?? null,
      totalWorkedMinutes: r?.totalWorkedMinutes ?? null,
      // 2026-09-16: "조기퇴근인데 사유가 없다"는 걸 관리자가 이 목록에서 바로 알아볼 수 있게
      // 노출한다(퇴근을 잘못 눌렀을 가능성이 있는 케이스를 admin/reports.tsx에서 배지로 표시).
      earlyLeaveReason: r?.earlyLeaveReason ?? null,
      // 정정(관리자 강제확정/위치이탈 자동감지 확정 포함)된 기록인지 — 관리자 화면에서 "정정됨" 배지와
      // 사유(추정시각 vs 실제 등)를 보여주는 데 쓴다.
      isCorrected: r?.isCorrected ?? false,
      correctionReason: r?.correctionReason ?? null,
      // 이동시간(공수 산정용) — 본인이 "이동중"으로 직접 찍은 시간 + 미기록 구간 자동추정치의 합.
      travelMinutes: totalTravelMinutes,
      travelHasEstimate: hasEstimatedTravel,
      latestStatus: lastLog ? { status: lastLog.status, changedAt: lastLog.changedAt, note: lastLog.note } : null,
      // 2026-09-08: 근무기록은 있는데 출근시각이 없거나(또는 크게 어긋나) 있으면 목록에서 바로
      // 배지로 보이게 한다(computeClockInMismatch 참고, 손주용 사례로 추가).
      clockInMismatch: computeClockInMismatch(userLogs, r?.clockInAt ?? null),
    };
  });
  return res.json({ success: true, data: { date: parsed.data.date, rows } });
});

const dailyTimelineSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  userId: z.string().min(1),
});

/**
 * 특정 직원의 특정 날짜 상태변화 타임라인 — "몇시부터 몇시까지 뭘 했는지"를 순서대로 보여준다.
 * 각 구간의 소요시간은 "다음 상태로 바뀐 시각(또는 퇴근시각)"과의 차이로 계산한다.
 */
reportsRouter.get('/daily-timeline', async (req, res) => {
  const parsed = dailyTimelineSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: 'date, userId가 필요합니다.' } });
  }
  const { date, userId } = parsed.data;
  const workDateLabel = new Date(`${date}T00:00:00.000Z`);
  const { start: dayStart, end: dayEnd } = realDayWindow(workDateLabel);

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { department: true } });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '직원을 찾을 수 없습니다.' } });
  }

  const record = await prisma.attendanceRecord.findUnique({ where: { userId_workDate: { userId, workDate: workDateLabel } } });
  const logs = await prisma.statusChangeLog.findMany({
    where: { userId, changedAt: { gte: dayStart, lt: dayEnd } },
    orderBy: { changedAt: 'asc' },
  });

  const defaultTravelMinutes = await getPolicyNumber('DEFAULT_TRAVEL_MINUTES', 30);
  const { segments: timeline, totalTravelMinutes } = computeTimelineSegments(logs, record?.clockOutAt ?? null, defaultTravelMinutes);

  return res.json({
    success: true,
    data: {
      date,
      name: user.name,
      department: user.department.name,
      clockInAt: record?.clockInAt ?? null,
      clockOutAt: record?.clockOutAt ?? null,
      clockOutLocation: record?.clockOutLocation ?? null,
      totalWorkedMinutes: record?.totalWorkedMinutes ?? null,
      // 2026-09-16: attendance-detail과 동일하게 조기퇴근 사유도 상세 타임라인에서 확인할 수 있게 함께 내려준다.
      earlyLeaveReason: record?.earlyLeaveReason ?? null,
      totalTravelMinutes,
      timeline,
      // 2026-09-08: 이 날짜의 근무기록과 출근시각이 어긋나 있으면(또는 출근시각 자체가 없으면)
      // 상세 타임라인 화면에서도 바로 경고로 보이게 한다(computeClockInMismatch 참고).
      clockInMismatch: computeClockInMismatch(logs, record?.clockInAt ?? null),
    },
  });
});

const forceClockOutSchema = z.object({
  clockOutAt: z.string().min(1), // datetime-local 또는 ISO 문자열(KST 기준으로 입력받아 그대로 Date 변환)
  reason: z.string().min(1),
});

/**
 * 관리자가 미퇴근 근무일을 직접 확정한다. 직원 본인의 신청 없이 진행되는 유일한 예외 경로라,
 * 반드시 사유를 남기고(isCorrected/correctionReason) 감사로그에도 actor를 남긴다 — "시스템이 임의로
 * 확정하지 않는다"는 원칙은 지키되, 사람(관리자)이 책임지고 결정하는 것까지 막지는 않는다.
 */
reportsRouter.post('/unresolved-clockouts/:recordId/force-clock-out', async (req, res) => {
  const parsed = forceClockOutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '퇴근시각과 사유를 모두 입력해주세요.' } });
  }
  const { recordId } = req.params;
  const { clockOutAt: clockOutAtRaw, reason } = parsed.data;

  const existing = await prisma.attendanceRecord.findUnique({
    where: { id: recordId },
    include: { breakSessions: true },
  });
  if (!existing || !existing.clockInAt) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '근태 기록을 찾을 수 없습니다.' } });
  }
  if (existing.clockOutAt) {
    return res.status(400).json({ success: false, error: { code: 'ALREADY_CLOCKED_OUT', message: '이미 퇴근 처리된 기록입니다.' } });
  }

  const clockOutAt = new Date(clockOutAtRaw);
  if (Number.isNaN(clockOutAt.getTime()) || clockOutAt <= existing.clockInAt) {
    return res.status(400).json({ success: false, error: { code: 'OUT_OF_RANGE', message: '퇴근 시각은 출근 이후여야 합니다.' } });
  }

  const totalBreakMinutes = existing.breakSessions.reduce((sum, b) => {
    if (!b.endAt) return sum;
    return sum + Math.round((b.endAt.getTime() - b.startAt.getTime()) / 60000);
  }, 0);
  const grossMinutes = Math.round((clockOutAt.getTime() - existing.clockInAt.getTime()) / 60000);
  const totalWorkedMinutes = Math.max(0, grossMinutes - totalBreakMinutes);

  const record = await prisma.attendanceRecord.update({
    where: { id: existing.id },
    data: {
      clockOutAt,
      totalWorkedMinutes,
      isCorrected: true,
      correctionReason: `[관리자 직접 확정] ${reason}`,
    },
  });

  await recordAuditLog({
    actorUserId: req.authUser!.userId,
    actionType: 'CORRECT',
    targetType: 'attendance_record',
    targetId: record.id,
    beforeValue: { clockOutAt: null },
    afterValue: { clockOutAt, totalWorkedMinutes, reason },
  });

  return res.json({ success: true, data: record });
});

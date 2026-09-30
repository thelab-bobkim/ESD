import { Router } from 'express';
import { z } from 'zod';
import ExcelJS from 'exceljs';
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

// 2026-09-18: "CSV 상위 메뉴(헤더)를 한글로 해달라"는 요청 반영 — headerLabels를 넘기면 헤더 줄만
// 한글 라벨로 바꿔서 출력하고, 실제 값을 꺼내는 키(row[h])는 원래 영문 필드명 그대로 쓴다(코드
// 안에서 데이터를 다루는 방식은 그대로 두고, 사람이 보는 화면만 한글화).
function toCSV(rows: Record<string, unknown>[], headerLabels?: Record<string, string>): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const headerRow = headers.map((h) => headerLabels?.[h] ?? h);
  const lines = [headerRow.map(csvField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h])).join(','));
  }
  return lines.join('\n');
}

// 엑셀(특히 한글 Windows)이 BOM 없는 UTF-8 CSV를 CP949로 오인해서 한글이 깨지는 것을 막기 위한
// BOM. res.send()에 이 값 + toCSV(...) 결과를 그대로 넘긴다.
const CSV_BOM = '﻿';

// 2026-09-18: CSV의 시각 컬럼이 그동안 UTC ISO 문자열("2026-09-17T23:59:40.655Z")로 그대로
// 나가서, 회사가 실제 쓰는 KST 기준 시각과 9시간 차이가 나 헷갈린다는(관리자가 "왜 출근시각이
// 자정 근처로 몰려있냐"고 오해할 수 있는) 문제가 있었다 — 화면(대시보드)에서는 이미 KST로 보여주고
// 있었는데 CSV만 원본 UTC를 그대로 내보내고 있었음. "YYYY-MM-DD HH:mm"(KST) 형태로 통일한다.
function kstDateTime(d: Date | null | undefined): string {
  if (!d) return '';
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const mo = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  const hh = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${day} ${hh}:${mm}`;
}

// 2026-09-18: "일별로 어떤 고객사에 몇 시간 일했는지 쉽게 보고 싶다" 요청 반영 — 분 단위는
// 매번 암산해야 해서, 시간 단위(소수 첫째자리)로 바로 계산되는 값으로 CSV에는 이 값만 내려준다.
// (같은 날 후속 문의로 "분 단위는 필요없고 시간 단위만 보여달라"고 확정돼, 분 컬럼 자체는
// CSV에서 뺐다 — 아래 각 export의 row 매핑에서 minutes/workedMinutes 원본값은 이 변환에만 쓰고
// 별도 컬럼으로 내보내지 않는다.)
function minutesToHours(minutes: number | null | undefined): number | '' {
  if (minutes == null) return '';
  return Math.round((minutes / 60) * 10) / 10;
}

// 2026-09-18: "실 공수시간 자동 산정"(경영관리부 요청) — EffortLog.actualMinutes(점심시간 실제
// 겹침만큼 뺀 값)가 있으면 그 값을, 없으면(이 필드 추가 이전의 과거 기록) 원본(minutes)을 그대로
// 쓴다. 고객사별 공수 집계(effort-summary)와 CSV 내보내기 모두 이 함수 하나로 통일해서, 한쪽만
// 실공수시간을 반영하고 다른 쪽은 원본을 쓰는 불일치가 생기지 않게 한다.
function effectiveEffortMinutes(l: { minutes: number | null; actualMinutes?: number | null }): number {
  return l.actualMinutes ?? l.minutes ?? 0;
}

const LEAVE_CONVERSION_STATUS_LABELS: Record<string, string> = {
  NONE: '해당없음',
  DRAFT: '임시저장',
  PENDING: '승인대기',
  APPROVED: '승인됨',
  REJECTED: '반려됨',
};

const ATTENDANCE_EXPORT_HEADERS: Record<string, string> = {
  employeeNo: '사번',
  name: '이름',
  workDate: '근무일자',
  clockInAt: '출근시각',
  clockOutAt: '퇴근시각',
  totalWorkedHours: '실근무시간(시간)',
};

const EFFORT_EXPORT_HEADERS: Record<string, string> = {
  employeeNo: '사번',
  name: '이름',
  workDate: '근무일자',
  clientName: '고객사',
  projectName: '프로젝트',
  workType: '작업유형',
  startTime: '시작시각',
  endTime: '종료시각',
  hours: '등록시간(시간)',
  // 2026-09-18: "실 공수시간 자동 산정"(경영관리부 요청) — 등록시간(원본)에서 정책에 정한
  // 점심시간대와 실제로 겹치는 만큼 뺀 값. 비용 산정 등 실제 업무에는 이 컬럼을 쓰고, 등록시간은
  // 감사·검증용으로 남겨둔다(effectiveEffortMinutes, attendance-helpers.ts lunchOverlapMinutes 참고).
  actualHours: '실공수시간(시간)',
  description: '비고',
};

const NIGHT_WORK_EXPORT_HEADERS: Record<string, string> = {
  employeeNo: '사번',
  name: '이름',
  startedAt: '시작시각',
  endedAt: '종료시각',
  workedHours: '근무시간(시간)',
  conversionStatus: '대체휴가 전환상태',
  convertedHours: '전환된시간(시간)',
};

// 2026-09-18: "고객사별 공수관리 화면에 나오는 것처럼, 사용자별로 매일 어떤 고객사에 얼마나
// 일했는지"를 CSV 한 장으로 바로 보고 싶다는 요청 — 기존 effort-export는 등록된 공수기록 원본을
// 한 줄씩 그대로 내보내서(같은 날 같은 고객사라도 여러 번 나눠 등록했으면 여러 줄로 나뉨), 하루
// 합계를 보려면 직접 엑셀에서 피벗을 만들어야 했다. 이 export는 (근무일자, 사용자, 고객사) 기준으로
// 미리 합산해서 한 줄로 내려준다 — "일별×사용자별×고객사별" 표가 바로 필요한 관리 목적에 맞춘 것.
const CLIENT_WORK_DAILY_EXPORT_HEADERS: Record<string, string> = {
  workDate: '근무일자',
  employeeNo: '사번',
  name: '이름',
  clientName: '고객사',
  // 2026-09-18: "실 공수시간 자동 산정" 요청 — 이 리포트는 애초에 고객사 비용/공수 산정이 목적이라,
  // 점심시간을 뺀 실공수시간을 바로 이 컬럼에 담는다(등록 원본을 보려면 effort-export CSV 참고).
  hours: '실공수시간(시간)',
};

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
    prevByClient.set(key, (prevByClient.get(key) ?? 0) + effectiveEffortMinutes(l));
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
    group.totalMinutes += effectiveEffortMinutes(l);
    group.workTypes.add(l.workType);
    const u = group.byUser.get(l.userId) ?? { userId: l.userId, name: l.user.name, department: l.user.department.name, minutes: 0 };
    u.minutes += effectiveEffortMinutes(l);
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
      // 2026-09-18: "실 공수시간 자동 산정" — 등록한 원본(minutes, 화면에 보이는 시작~종료 시각과
      // 정확히 일치)과 별도로, 점심시간 실제 겹침을 뺀 실공수시간도 같이 내려준다. 프론트가 둘이
      // 다를 때만("점심시간 N분 차감") 표시해서, 왜 시간이 줄었는지 숨기지 않고 보여준다.
      actualMinutes: effectiveEffortMinutes(l),
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
    // 2026-09-30 수정: take 상한이 있으면 회사 전체 근태/공수기록이 최근 며칠치만 남고 조용히
    // 잘려나간다(150명 규모면 하루 100건 넘게 쌓여 1000~5000건 상한을 금방 넘김) — 이 엔드포인트는
    // 페이지네이션 없는 전체기간 다운로드용 리포트라 상한을 두지 않는다(주간/월간 누계가 실제보다
    // 낮게 나와도 에러 없이 그대로 내려가던 문제).
  });
  const rows = logs.map((l) => ({
    employeeNo: l.user.employeeNo,
    name: l.user.name,
    workDate: l.workDate.toISOString().slice(0, 10),
    clientName: l.clientName,
    projectName: l.projectName,
    workType: l.workType,
    startTime: kstDateTime(l.startTime),
    endTime: kstDateTime(l.endTime),
    hours: minutesToHours(l.minutes),
    actualHours: minutesToHours(effectiveEffortMinutes(l)),
    description: l.description ?? '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="effort-export.csv"');
  return res.send(CSV_BOM + toCSV(rows, EFFORT_EXPORT_HEADERS));
});

/**
 * 2026-09-18: "고객사별 공수관리 화면처럼, 사용자별로 매일 어떤 고객사에 얼마나 일했는지 CSV로
 * 보고 싶다"는 요청 — effort-export(원본 기록 그대로, 같은 날 같은 고객사도 여러 줄로 나뉠 수 있음)
 * 와 달리, (근무일자, 사용자, 고객사) 단위로 미리 합산해서 한 줄로 보여준다. 완료된(작업시간이
 * 계산된) 기록만, 고객사명이 있는 기록만 대상으로 한다(effort-summary와 동일한 기준).
 */
reportsRouter.get('/client-work-daily-export', async (_req, res) => {
  const logs = await prisma.effortLog.findMany({
    where: { minutes: { not: null } },
    include: { user: { select: { name: true, employeeNo: true } } },
    orderBy: { workDate: 'desc' },
    // 2026-09-30 수정: take 상한이 있으면 회사 전체 근태/공수기록이 최근 며칠치만 남고 조용히
    // 잘려나간다(150명 규모면 하루 100건 넘게 쌓여 1000~5000건 상한을 금방 넘김) — 이 엔드포인트는
    // 페이지네이션 없는 전체기간 다운로드용 리포트라 상한을 두지 않는다(주간/월간 누계가 실제보다
    // 낮게 나와도 에러 없이 그대로 내려가던 문제).
  });

  interface DailyClientGroup {
    workDate: string;
    employeeNo: string;
    name: string;
    clientName: string;
    minutes: number;
  }
  const byKey = new Map<string, DailyClientGroup>();
  for (const l of logs) {
    const clientName = l.clientName?.trim();
    if (!clientName) continue; // 사내 업무일지 등 고객사명이 없는 기록은 이 리포트 목적상 제외(effort-summary와 동일한 기준)
    const workDate = l.workDate.toISOString().slice(0, 10);
    const key = `${workDate}::${l.userId}::${clientName}`;
    const group = byKey.get(key) ?? { workDate, employeeNo: l.user.employeeNo, name: l.user.name, clientName, minutes: 0 };
    group.minutes += effectiveEffortMinutes(l);
    byKey.set(key, group);
  }

  const rows = Array.from(byKey.values())
    .sort((a, b) => b.workDate.localeCompare(a.workDate) || a.name.localeCompare(b.name, 'ko') || a.clientName.localeCompare(b.clientName, 'ko'))
    .map((g) => ({
      workDate: g.workDate,
      employeeNo: g.employeeNo,
      name: g.name,
      clientName: g.clientName,
      hours: minutesToHours(g.minutes),
    }));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="client-work-daily-export.csv"');
  return res.send(CSV_BOM + toCSV(rows, CLIENT_WORK_DAILY_EXPORT_HEADERS));
});

reportsRouter.get('/attendance-export', async (req, res) => {
  const records = await prisma.attendanceRecord.findMany({
    where: { user: { includedInBoard: true } },
    include: { user: { select: { name: true, employeeNo: true } } },
    orderBy: { workDate: 'desc' },
    // 2026-09-30 수정: take 상한이 있으면 회사 전체 근태/공수기록이 최근 며칠치만 남고 조용히
    // 잘려나간다(150명 규모면 하루 100건 넘게 쌓여 1000~5000건 상한을 금방 넘김) — 이 엔드포인트는
    // 페이지네이션 없는 전체기간 다운로드용 리포트라 상한을 두지 않는다(주간/월간 누계가 실제보다
    // 낮게 나와도 에러 없이 그대로 내려가던 문제).
  });
  const rows = records.map((r) => ({
    employeeNo: r.user.employeeNo,
    name: r.user.name,
    workDate: r.workDate.toISOString().slice(0, 10),
    clockInAt: kstDateTime(r.clockInAt),
    clockOutAt: kstDateTime(r.clockOutAt),
    totalWorkedHours: minutesToHours(r.totalWorkedMinutes),
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance-export.csv"');
  return res.send(CSV_BOM + toCSV(rows, ATTENDANCE_EXPORT_HEADERS));
});

// 2026-09-19: "CSV 내려받기"와 "일별 고객사 작업시간 CSV" 버튼 2개가 따로 있어서 헷갈린다는
// 요청 — 두 데이터(출퇴근시간 + 고객사별 작업시간)를 엑셀 한 파일에 합치고, 일별 상세 외에
// 주별·월별 누계까지 시트로 같이 담는다(CSV는 시트 개념이 없어서 xlsx로 전환). 기존
// /attendance-export, /client-work-daily-export CSV 엔드포인트는 그대로 남겨둔다(다른 곳에서
// 이 원본 CSV가 필요할 수 있어 하위호환 목적으로 유지 — 화면의 다운로드 버튼만 이걸로 교체).
function mondayOf(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const day = d.getUTCDay(); // 0=일 .. 6=토
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diffToMonday);
  return monday;
}
function weekLabelOf(dateStr: string): string {
  const monday = mondayOf(dateStr);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const f = (x: Date) => x.toISOString().slice(0, 10);
  return `${f(monday)} ~ ${f(sunday)}`;
}

// 2026-09-19: "영업부/기술부 등으로 구분해달라, 다우오피스 조직도 데이터를 기본으로" 요청 —
// frontend/src/lib/deptGroup.ts의 classifyDeptGroup과 동일한 기준을 백엔드에도 그대로 옮겨왔다
// (이 엑셀은 서버에서 만들어서, 프론트 쪽 분류 함수를 그대로 재사용할 수 없다 — 두 파일을 같이
// 고쳐야 함에 유의). department는 다우오피스 조직도 동기화로 채워지는 User.department.name을
// 그대로 쓴다(수동 입력이 아니라 조직도 기준).
type DeptGroup = 'sales' | 'tech' | 'other';
const TECH_DEPT_KEYWORDS = ['솔루션', '엔지니어', '기술지원', '클라우드', 'back-up', 'cluster'];
function classifyDeptGroup(department: string): DeptGroup {
  if (department.includes('사업')) return 'sales';
  const lower = department.toLowerCase();
  if (TECH_DEPT_KEYWORDS.some((kw) => lower.includes(kw))) return 'tech';
  return 'other';
}
const DEPT_GROUP_LABELS: Record<DeptGroup, string> = { sales: '영업부', tech: '기술부', other: '기타' };
const DEPT_GROUP_ORDER: Record<DeptGroup, number> = { sales: 0, tech: 1, other: 2 };

reportsRouter.get('/attendance-work-export', async (_req, res) => {
  const [records, logs] = await Promise.all([
    prisma.attendanceRecord.findMany({
      where: { user: { includedInBoard: true } },
      include: { user: { select: { name: true, employeeNo: true, department: { select: { name: true } } } } },
      orderBy: { workDate: 'desc' },
      // 2026-09-30 수정: take 상한이 있으면 회사 전체 근태/공수기록이 최근 며칠치만 남고 조용히
    // 잘려나간다(150명 규모면 하루 100건 넘게 쌓여 1000~5000건 상한을 금방 넘김) — 이 엔드포인트는
    // 페이지네이션 없는 전체기간 다운로드용 리포트라 상한을 두지 않는다(주간/월간 누계가 실제보다
    // 낮게 나와도 에러 없이 그대로 내려가던 문제).
    }),
    prisma.effortLog.findMany({
      where: { minutes: { not: null } },
      include: { user: { select: { name: true, employeeNo: true, department: { select: { name: true } } } } },
      orderBy: { workDate: 'desc' },
      // 2026-09-30 수정: take 상한이 있으면 회사 전체 근태/공수기록이 최근 며칠치만 남고 조용히
    // 잘려나간다(150명 규모면 하루 100건 넘게 쌓여 1000~5000건 상한을 금방 넘김) — 이 엔드포인트는
    // 페이지네이션 없는 전체기간 다운로드용 리포트라 상한을 두지 않는다(주간/월간 누계가 실제보다
    // 낮게 나와도 에러 없이 그대로 내려가던 문제).
    }),
  ]);

  const userInfo = new Map<string, { employeeNo: string; name: string; department: string }>();
  for (const r of records) userInfo.set(r.userId, { employeeNo: r.user.employeeNo, name: r.user.name, department: r.user.department.name });
  for (const l of logs) userInfo.set(l.userId, { employeeNo: l.user.employeeNo, name: l.user.name, department: l.user.department.name });

  interface DailyRow {
    workDate: string; userId: string; clockInAt: Date | null; clockOutAt: Date | null;
    totalWorkedMinutes: number | null; clientMinutes: Map<string, number>;
  }
  const dailyKey = (workDate: string, userId: string) => `${workDate}::${userId}`;
  const dailyMap = new Map<string, DailyRow>();

  for (const r of records) {
    const workDate = r.workDate.toISOString().slice(0, 10);
    dailyMap.set(dailyKey(workDate, r.userId), {
      workDate, userId: r.userId, clockInAt: r.clockInAt, clockOutAt: r.clockOutAt,
      totalWorkedMinutes: r.totalWorkedMinutes, clientMinutes: new Map(),
    });
  }
  for (const l of logs) {
    const clientName = l.clientName?.trim();
    if (!clientName) continue; // client-work-daily-export와 동일한 기준(고객사명 없는 사내업무 등은 제외)
    const workDate = l.workDate.toISOString().slice(0, 10);
    const key = dailyKey(workDate, l.userId);
    let row = dailyMap.get(key);
    if (!row) {
      row = { workDate, userId: l.userId, clockInAt: null, clockOutAt: null, totalWorkedMinutes: null, clientMinutes: new Map() };
      dailyMap.set(key, row);
    }
    row.clientMinutes.set(clientName, (row.clientMinutes.get(clientName) ?? 0) + effectiveEffortMinutes(l));
  }

  interface AggRow { workedMinutes: number; clientMinutes: number }
  const weeklyMap = new Map<string, AggRow>();
  const monthlyMap = new Map<string, AggRow>();
  for (const row of dailyMap.values()) {
    const clientTotal = Array.from(row.clientMinutes.values()).reduce((a, b) => a + b, 0);
    const wKey = `${weekLabelOf(row.workDate)}::${row.userId}`;
    const wAgg = weeklyMap.get(wKey) ?? { workedMinutes: 0, clientMinutes: 0 };
    wAgg.workedMinutes += row.totalWorkedMinutes ?? 0;
    wAgg.clientMinutes += clientTotal;
    weeklyMap.set(wKey, wAgg);

    const mKey = `${row.workDate.slice(0, 7)}::${row.userId}`;
    const mAgg = monthlyMap.get(mKey) ?? { workedMinutes: 0, clientMinutes: 0 };
    mAgg.workedMinutes += row.totalWorkedMinutes ?? 0;
    mAgg.clientMinutes += clientTotal;
    monthlyMap.set(mKey, mAgg);
  }

  const workbook = new ExcelJS.Workbook();

  const dailySheet = workbook.addWorksheet('일별');
  dailySheet.columns = [
    { header: '구분', key: 'deptGroupLabel', width: 10 },
    { header: '부서', key: 'department', width: 18 },
    { header: '사번', key: 'employeeNo', width: 12 },
    { header: '이름', key: 'name', width: 10 },
    { header: '근무일자', key: 'workDate', width: 12 },
    { header: '출근시각', key: 'clockInAt', width: 16 },
    { header: '퇴근시각', key: 'clockOutAt', width: 16 },
    { header: '실근무시간(시간)', key: 'totalWorkedHours', width: 14 },
    { header: '고객사별 작업시간', key: 'clientBreakdown', width: 44 },
    { header: '고객사작업 합계(시간)', key: 'clientTotalHours', width: 18 },
  ];
  // 날짜(최신순)를 1순위로 유지하면서, 같은 날짜 안에서는 구분(영업부/기술부/기타)→부서→이름
  // 순으로 묶어서 조직도 기준으로 한눈에 보이게 정렬한다.
  const dailyRowsSorted = Array.from(dailyMap.values()).sort((a, b) => {
    if (a.workDate !== b.workDate) return b.workDate.localeCompare(a.workDate);
    const deptA = userInfo.get(a.userId)?.department ?? '';
    const deptB = userInfo.get(b.userId)?.department ?? '';
    const groupOrderDiff = DEPT_GROUP_ORDER[classifyDeptGroup(deptA)] - DEPT_GROUP_ORDER[classifyDeptGroup(deptB)];
    if (groupOrderDiff !== 0) return groupOrderDiff;
    const deptDiff = deptA.localeCompare(deptB, 'ko');
    if (deptDiff !== 0) return deptDiff;
    return (userInfo.get(a.userId)?.name ?? '').localeCompare(userInfo.get(b.userId)?.name ?? '', 'ko');
  });
  for (const row of dailyRowsSorted) {
    const info = userInfo.get(row.userId);
    const clientTotalMinutes = Array.from(row.clientMinutes.values()).reduce((a, b) => a + b, 0);
    const breakdown = Array.from(row.clientMinutes.entries())
      .map(([name, min]) => `${name}:${minutesToHours(min)}h`)
      .join('; ');
    dailySheet.addRow({
      deptGroupLabel: DEPT_GROUP_LABELS[classifyDeptGroup(info?.department ?? '')],
      department: info?.department ?? '',
      employeeNo: info?.employeeNo ?? '',
      name: info?.name ?? '',
      workDate: row.workDate,
      clockInAt: kstDateTime(row.clockInAt),
      clockOutAt: kstDateTime(row.clockOutAt),
      totalWorkedHours: minutesToHours(row.totalWorkedMinutes),
      clientBreakdown: breakdown,
      clientTotalHours: minutesToHours(clientTotalMinutes),
    });
  }
  dailySheet.getRow(1).font = { bold: true };

  function addAggSheet(sheetName: string, map: Map<string, AggRow>, periodHeader: string) {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.columns = [
      { header: '구분', key: 'deptGroupLabel', width: 10 },
      { header: '부서', key: 'department', width: 18 },
      { header: '사번', key: 'employeeNo', width: 12 },
      { header: '이름', key: 'name', width: 10 },
      { header: periodHeader, key: 'periodLabel', width: 24 },
      { header: '총근무시간(시간)', key: 'workedHours', width: 16 },
      { header: '고객사작업 합계(시간)', key: 'clientHours', width: 18 },
    ];
    const rows = Array.from(map.entries())
      .map(([key, agg]) => {
        const sep = key.lastIndexOf('::');
        const periodLabel = key.slice(0, sep);
        const userId = key.slice(sep + 2);
        const info = userInfo.get(userId);
        const department = info?.department ?? '';
        return {
          periodLabel,
          deptGroup: classifyDeptGroup(department),
          deptGroupLabel: DEPT_GROUP_LABELS[classifyDeptGroup(department)],
          department,
          employeeNo: info?.employeeNo ?? '',
          name: info?.name ?? '',
          workedHours: minutesToHours(agg.workedMinutes),
          clientHours: minutesToHours(agg.clientMinutes),
        };
      })
      .sort((a, b) =>
        b.periodLabel.localeCompare(a.periodLabel) ||
        (DEPT_GROUP_ORDER[a.deptGroup] - DEPT_GROUP_ORDER[b.deptGroup]) ||
        a.department.localeCompare(b.department, 'ko') ||
        a.name.localeCompare(b.name, 'ko')
      );
    for (const r of rows) sheet.addRow(r);
    sheet.getRow(1).font = { bold: true };
  }
  addAggSheet('주별 누계', weeklyMap, '주간(월~일)');
  addAggSheet('월별 누계', monthlyMap, '월');

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="attendance-work-export.xlsx"');
  const buffer = await workbook.xlsx.writeBuffer();
  return res.send(Buffer.from(buffer));
});

reportsRouter.get('/night-work-export', async (req, res) => {
  const sessions = await prisma.nightWorkSession.findMany({
    where: { user: { includedInBoard: true } },
    include: { user: { select: { name: true, employeeNo: true } }, leaveConversionRequest: true },
    orderBy: { startedAt: 'desc' },
    // 2026-09-30 수정: take 상한이 있으면 회사 전체 근태/공수기록이 최근 며칠치만 남고 조용히
    // 잘려나간다(150명 규모면 하루 100건 넘게 쌓여 1000~5000건 상한을 금방 넘김) — 이 엔드포인트는
    // 페이지네이션 없는 전체기간 다운로드용 리포트라 상한을 두지 않는다(주간/월간 누계가 실제보다
    // 낮게 나와도 에러 없이 그대로 내려가던 문제).
  });
  const rows = sessions.map((s) => ({
    employeeNo: s.user.employeeNo,
    name: s.user.name,
    startedAt: kstDateTime(s.startedAt),
    endedAt: kstDateTime(s.endedAt),
    workedHours: minutesToHours(s.workedMinutes),
    conversionStatus: LEAVE_CONVERSION_STATUS_LABELS[s.leaveConversionRequest?.status ?? 'NONE'] ?? (s.leaveConversionRequest?.status ?? '해당없음'),
    convertedHours: minutesToHours(s.leaveConversionRequest?.convertedMinutes),
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="night-work-export.csv"');
  return res.send(CSV_BOM + toCSV(rows, NIGHT_WORK_EXPORT_HEADERS));
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

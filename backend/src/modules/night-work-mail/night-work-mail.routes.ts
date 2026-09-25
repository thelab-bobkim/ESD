import { Router } from 'express';
import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';

/**
 * 야간·주말작업 보고서(아웃룩 메일 자동수집) 모듈.
 * 2026-09-25: 김형태 대표이사 요청 — 엔지니어들이 아웃룩 '받은편지함 > 야간작업및 주말작업' 폴더로
 * 보내는 자기보고 메일을 매번 직접 열지 않고도 TSB 관리자 화면에서 한눈에 보기 위함.
 *
 * 이 모듈이 다루는 데이터는 night-work.routes.ts(NightWorkSession — 직원이 앱에서 직접
 * 시작/종료해서 대체휴무로 전환하는 사내 근무기록)와 완전히 별개다. 여기 데이터는 아웃룩 메일
 * 원문을 그대로 옮겨온 열람 전용 참고자료이며, 근태/공수/상태변경에 전혀 영향을 주지 않는다.
 *
 * /sync 는 일반 직원/관리자 로그인이 아니라 Claude(외부 자동화, Microsoft 365 연동)가 주기적으로
 * 호출하는 용도라 requireAuth 대신 고정 키(NIGHT_WORK_MAIL_SYNC_KEY) 인증을 쓴다 — 그래서 이 라우터
 * 안에서 requireAuth를 등록하기 전에 /sync를 먼저 선언한다(Express는 등록 순서대로 미들웨어가 붙는다).
 */
export const nightWorkMailRouter = Router();

function requireSyncKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.NIGHT_WORK_MAIL_SYNC_KEY;
  if (!expected) {
    return res.status(503).json({
      success: false,
      error: { code: 'SYNC_NOT_CONFIGURED', message: '서버에 NIGHT_WORK_MAIL_SYNC_KEY가 설정되어 있지 않습니다.' },
    });
  }
  const provided = req.headers['x-sync-key'];
  if (provided !== expected) {
    return res.status(401).json({ success: false, error: { code: 'INVALID_SYNC_KEY', message: '동기화 키가 올바르지 않습니다.' } });
  }
  next();
}

const syncItemSchema = z.object({
  mailInternetMessageId: z.string().min(1),
  itemIndex: z.number().int().min(0).default(0),
  kind: z.enum(['NIGHT', 'WEEKEND']),
  workDate: z.string().min(1), // ISO date string ("2026-09-22")
  reporterName: z.string().min(1),
  reporterEmail: z.string().min(1),
  clientNameRaw: z.string().min(1),
  location: z.string().nullable().optional(),
  workTimeRaw: z.string().nullable().optional(),
  workContent: z.string().nullable().optional(),
  workers: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  mailReceivedAt: z.string().min(1), // ISO datetime string
  mailWebLink: z.string().nullable().optional(),
});

const syncSchema = z.object({
  items: z.array(syncItemSchema).min(1).max(500),
});

/**
 * 아웃룩에서 새로 파싱한 보고 건을 밀어넣는다(upsert). 같은 메일을 다시 보내도
 * (mailInternetMessageId, itemIndex) 조합이 같으면 덮어쓸 뿐 중복 생성되지 않는다 — 매주/매월
 * 재동기화해도 안전하다.
 */
nightWorkMailRouter.post('/sync', requireSyncKey, async (req, res) => {
  const parsed = syncSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? '입력값을 확인하세요.' },
    });
  }

  let created = 0;
  let updated = 0;
  for (const item of parsed.data.items) {
    const existing = await prisma.nightWorkMailReport.findUnique({
      where: {
        mailInternetMessageId_itemIndex: {
          mailInternetMessageId: item.mailInternetMessageId,
          itemIndex: item.itemIndex,
        },
      },
      select: { id: true },
    });
    await prisma.nightWorkMailReport.upsert({
      where: {
        mailInternetMessageId_itemIndex: {
          mailInternetMessageId: item.mailInternetMessageId,
          itemIndex: item.itemIndex,
        },
      },
      create: {
        mailInternetMessageId: item.mailInternetMessageId,
        itemIndex: item.itemIndex,
        kind: item.kind,
        workDate: new Date(item.workDate),
        reporterName: item.reporterName,
        reporterEmail: item.reporterEmail,
        clientNameRaw: item.clientNameRaw,
        location: item.location ?? null,
        workTimeRaw: item.workTimeRaw ?? null,
        workContent: item.workContent ?? null,
        workers: item.workers ?? null,
        note: item.note ?? null,
        mailReceivedAt: new Date(item.mailReceivedAt),
        mailWebLink: item.mailWebLink ?? null,
      },
      update: {
        kind: item.kind,
        workDate: new Date(item.workDate),
        reporterName: item.reporterName,
        reporterEmail: item.reporterEmail,
        clientNameRaw: item.clientNameRaw,
        location: item.location ?? null,
        workTimeRaw: item.workTimeRaw ?? null,
        workContent: item.workContent ?? null,
        workers: item.workers ?? null,
        note: item.note ?? null,
        mailReceivedAt: new Date(item.mailReceivedAt),
        mailWebLink: item.mailWebLink ?? null,
      },
    });
    if (existing) updated += 1;
    else created += 1;
  }

  return res.json({ success: true, data: { created, updated, total: parsed.data.items.length } });
});

// 아래부터는 일반 관리자 화면 조회용 — 로그인 + HR_ADMIN/SYSTEM_ADMIN 권한 필요
// (admin/clients.tsx 등 다른 관리자 전용 메뉴와 동일한 권한 체계).
nightWorkMailRouter.use(requireAuth, requireRole('HR_ADMIN', 'SYSTEM_ADMIN'));

const listQuerySchema = z.object({
  from: z.string().optional(), // "2026-09-01"
  to: z.string().optional(), // "2026-09-30"
  kind: z.enum(['NIGHT', 'WEEKEND']).optional(),
  q: z.string().optional(), // 고객사/보고자/작업인원 부분일치 검색
});

nightWorkMailRouter.get('/', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '조회 조건을 확인하세요.' } });
  }
  const { from, to, kind, q } = parsed.data;

  const where: Record<string, unknown> = {};
  if (from || to) {
    where.workDate = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }
  if (kind) where.kind = kind;
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { clientNameRaw: { contains: term, mode: 'insensitive' } },
      { reporterName: { contains: term, mode: 'insensitive' } },
      { workers: { contains: term, mode: 'insensitive' } },
      { location: { contains: term, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.nightWorkMailReport.findMany({
    where,
    orderBy: [{ workDate: 'desc' }, { mailReceivedAt: 'desc' }],
    take: 1000,
  });
  return res.json({ success: true, data: rows });
});

/** 인원별/고객사별 집계 — 목록과 같은 필터(from/to/kind/q)를 적용한 뒤 서버에서 집계해 내려준다. */
nightWorkMailRouter.get('/summary', async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '조회 조건을 확인하세요.' } });
  }
  const { from, to, kind, q } = parsed.data;

  const where: Record<string, unknown> = {};
  if (from || to) {
    where.workDate = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }
  if (kind) where.kind = kind;
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { clientNameRaw: { contains: term, mode: 'insensitive' } },
      { reporterName: { contains: term, mode: 'insensitive' } },
      { workers: { contains: term, mode: 'insensitive' } },
      { location: { contains: term, mode: 'insensitive' } },
    ];
  }

  const rows = await prisma.nightWorkMailReport.findMany({ where, select: { kind: true, clientNameRaw: true, workers: true } });

  const byEngineer = new Map<string, number>();
  const byClient = new Map<string, number>();
  let nightCount = 0;
  let weekendCount = 0;
  for (const row of rows) {
    if (row.kind === 'NIGHT') nightCount += 1;
    else if (row.kind === 'WEEKEND') weekendCount += 1;
    byClient.set(row.clientNameRaw, (byClient.get(row.clientNameRaw) ?? 0) + 1);
    for (const name of (row.workers ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
      byEngineer.set(name, (byEngineer.get(name) ?? 0) + 1);
    }
  }

  return res.json({
    success: true,
    data: {
      total: rows.length,
      nightCount,
      weekendCount,
      byEngineer: Array.from(byEngineer.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      byClient: Array.from(byClient.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    },
  });
});

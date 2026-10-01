import { createRouter } from '../../common/async-router';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { syncEmployeesFromDauoffice } from './sync-employees';
import { scrapeCompanyLeaveStatus } from './leave-scraper';

export const dauofficeRouter = createRouter();
dauofficeRouter.use(requireAuth, requireRole('HR_ADMIN', 'SYSTEM_ADMIN'));

/** 직원(조직도) 수동 동기화 트리거 */
dauofficeRouter.post('/sync/employees', async (req, res) => {
  const result = await syncEmployeesFromDauoffice(req.authUser!.userId);
  return res.json({ success: true, data: result });
});

// 2026-09-01: "근태(출퇴근) 동기화"는 제거했다 — 다우오피스가 퇴근시각을 제공하지 않아 매달
// clockInAt만 채운 미해결(퇴근 없음) 기록이 계속 쌓이는 원인이었다(정정 신청 목록이 끝없이
// 쌓이던 문제). 사용자 요청으로 이 버튼/엔드포인트를 없앴다 — 출퇴근은 이제 앱 안에서 직원이
// 직접 누른 것만 기록으로 인정한다. 조직도(직원) 동기화는 부서 변경 등을 반영해야 하므로 유지.
// (구현은 sync-attendance.ts에 남아있지만 더 이상 라우트에 연결하지 않는다.)

// 2026-09-04: 휴가현황 연동 가능 여부를 확인하려고 만들었던 진단 엔드포인트(/probe/attendance-codes)는
// 제거했다 — 실제로 조회해보니 다우오피스 attnd-v2/attnd 응답의 dayWorkStatusCode/workGroupCode/
// shiftWorkPolicyCode가 이 계정에서는 전부 null로만 내려오고, 출근시각 유무만으로는 다우오피스
// "전사 휴가현황"의 실제 휴가자와 맞지 않는 것을 확인했다(우리 앱으로 출퇴근을 관리하다 보니
// 다우오피스 자체 출근체크를 안 쓰는 사람이 대부분이라 "출근없음"이 휴가와 무관하게 대량 발생).
// 즉 이 API로는 휴가 여부를 구분할 수 없다 — 정식 휴가 API가 확인되면 그때 다시 시도한다.

// 2026-09-18: 위 문제의 대안으로, 다우오피스 "전사 휴가현황" 화면을 headless 브라우저로 직접
// 읽어오는 스크래핑을 추가했다(leave-scraper.ts). 로그인 단계는 실제 로그인 페이지 구조를 보지
// 못한 채 작성한 추정치라 첫 실행은 반드시 dryRun=true로 결과부터 확인해야 한다. 스크래핑 결과는
// 직원의 실시간 상태값(StatusChangeLog)을 건드리지 않고 dashboard.routes.ts의 "오늘의 휴가자"
// 섹션에만 별도로 반영된다(관리자 확정 방향 — 예전에 다우오피스 출퇴근 자동동기화를 아예 껐던
// 것과 같은 이유: 직원이 앱에서 직접 등록한 상태와 충돌하지 않게 하기 위함).

/**
 * "전사 휴가현황" 수동 스크래핑 트리거. dryRun=true면 DB에 저장하지 않고 파싱 결과만 돌려준다 —
 * 로그인/표 파싱 셀렉터가 실제 다우오피스 화면과 맞는지 먼저 확인하는 용도.
 */
dauofficeRouter.post('/leave/scrape', async (req, res) => {
  const dryRun = req.query.dryRun === 'true';
  try {
    const result = await scrapeCompanyLeaveStatus({ dryRun });
    await recordAuditLog({
      actorUserId: req.authUser!.userId,
      actionType: 'DAUOFFICE_LEAVE_SCRAPE',
      targetType: 'dauoffice_leave_entry',
      targetId: dryRun ? 'dry-run' : 'scrape',
      afterValue: { scrapedRowCount: result.scrapedRowCount, savedCount: result.savedCount, unmatchedCount: result.unmatched.length },
    });
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'LEAVE_SCRAPE_FAILED', message: err instanceof Error ? err.message : '휴가현황 스크래핑에 실패했습니다.' },
    });
  }
});

/** 부서명 수동 보정값 목록 조회 (AMS의 하드코딩 DEPT_MAP을 대체하는 테이블) */
dauofficeRouter.get('/department-overrides', async (_req, res) => {
  const overrides = await prisma.dauofficeDepartmentOverride.findMany({ orderBy: { dauofficeLoginId: 'asc' } });
  return res.json({ success: true, data: overrides });
});

const upsertOverrideSchema = z.object({
  dauofficeLoginId: z.string().min(1),
  departmentName: z.string().min(1),
});

/** 부서명 수동 보정값 추가/수정 */
dauofficeRouter.put('/department-overrides', async (req, res) => {
  const parsed = upsertOverrideSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
  }
  const { dauofficeLoginId, departmentName } = parsed.data;
  const updated = await prisma.dauofficeDepartmentOverride.upsert({
    where: { dauofficeLoginId },
    update: { departmentName },
    create: { dauofficeLoginId, departmentName },
  });
  await recordAuditLog({
    actorUserId: req.authUser!.userId,
    actionType: 'POLICY_CHANGE',
    targetType: 'dauoffice_department_override',
    targetId: updated.id,
    afterValue: updated,
  });
  return res.json({ success: true, data: updated });
});

/** 부서명 수동 보정값 삭제 */
dauofficeRouter.delete('/department-overrides/:loginId', async (req, res) => {
  const existing = await prisma.dauofficeDepartmentOverride.findUnique({
    where: { dauofficeLoginId: req.params.loginId },
  });
  if (!existing) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '보정값을 찾을 수 없습니다.' } });
  }
  await prisma.dauofficeDepartmentOverride.delete({ where: { id: existing.id } });
  await recordAuditLog({
    actorUserId: req.authUser!.userId,
    actionType: 'POLICY_CHANGE',
    targetType: 'dauoffice_department_override',
    targetId: existing.id,
    beforeValue: existing,
  });
  return res.json({ success: true, data: { deleted: true } });
});

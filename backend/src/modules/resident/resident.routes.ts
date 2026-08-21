import { Router } from 'express';
import { prisma } from '../../common/prisma';
import { requireAuth } from '../../common/guards/auth';
import { recordAuditLog } from '../../common/audit';
import { ensureClockIn } from '../../common/attendance-helpers';

export const residentRouter = Router();
residentRouter.use(requireAuth);

/**
 * 고객사 상주 도착 체크.
 * 좌표(lat/lng)는 저장하지 않는다 — "도착 여부 / 현재 상태 / 마지막 확인 시각" 원칙(core_principles).
 * 주52시간제 대응: 고객사 도착을 "실제 업무 시작"으로 보고 그날 출근시각을 자동 인식한다.
 */
residentRouter.post('/checkin', async (req, res) => {
  const userId = req.authUser!.userId;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.assignedClientId) {
    return res.status(400).json({ success: false, error: { code: 'NO_ASSIGNED_CLIENT', message: '배정된 고객사가 없습니다.' } });
  }

  const checkin = await prisma.residentCheckin.create({
    data: { userId, clientId: user.assignedClientId, checkinAt: new Date(), lastConfirmedAt: new Date() },
  });
  await prisma.statusChangeLog.create({ data: { userId, status: 'RESIDENT_ONSITE', source: 'WEB' } });
  await ensureClockIn(userId);
  await recordAuditLog({ actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'resident_checkin', targetId: checkin.id, afterValue: checkin });

  return res.json({ success: true, data: checkin });
});

/** 상태 재확인(마지막 확인시각 갱신) — 미확인 알림 방지용 간단 핑 */
residentRouter.post('/confirm', async (req, res) => {
  const userId = req.authUser!.userId;
  const latest = await prisma.residentCheckin.findFirst({ where: { userId }, orderBy: { checkinAt: 'desc' } });
  if (!latest) {
    return res.status(400).json({ success: false, error: { code: 'NO_CHECKIN', message: '도착체크 기록이 없습니다.' } });
  }
  const updated = await prisma.residentCheckin.update({ where: { id: latest.id }, data: { lastConfirmedAt: new Date() } });
  return res.json({ success: true, data: updated });
});

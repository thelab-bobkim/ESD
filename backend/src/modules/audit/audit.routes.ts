import { Router } from 'express';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';

export const auditRouter = Router();
auditRouter.use(requireAuth, requireRole('SYSTEM_ADMIN'));

auditRouter.get('/logs', async (req, res) => {
  const { userId, actionType, from, to } = req.query as Record<string, string | undefined>;

  const logs = await prisma.auditLog.findMany({
    where: {
      actorUserId: userId || undefined,
      actionType: (actionType as any) || undefined,
      createdAt: {
        gte: from ? new Date(from) : undefined,
        lte: to ? new Date(to) : undefined,
      },
    },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });

  return res.json({ success: true, data: logs });
});

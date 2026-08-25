import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';

export const clientsRouter = Router();
clientsRouter.use(requireAuth, requireRole('HR_ADMIN', 'SYSTEM_ADMIN'));

/** 고객사 목록 + 좌표 등록 여부 (위치대조 기능용 관리 화면) */
clientsRouter.get('/', async (_req, res) => {
  const clients = await prisma.client.findMany({ orderBy: { name: 'asc' } });
  return res.json({
    success: true,
    data: clients.map((c) => ({
      id: c.id,
      name: c.name,
      address: c.address,
      latitude: c.latitude,
      longitude: c.longitude,
      hasCoordinates: c.latitude != null && c.longitude != null,
    })),
  });
});

const updateCoordsSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  // 지도에서 검색해서 찾은 주소가 있으면 같이 갱신한다(선택값 — 직접입력 저장 시엔 안 넘어옴).
  address: z.string().optional(),
});

/** 고객사 좌표 등록/수정 — 위치대조에 쓸 기준 좌표. 지도(구글맵 등)에서 조회한 값을 그대로 입력하면 된다. */
clientsRouter.put('/:id/coordinates', async (req, res) => {
  const parsed = updateCoordsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '위도/경도 값을 확인하세요.' } });
  }
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '고객사를 찾을 수 없습니다.' } });
  }
  const updated = await prisma.client.update({
    where: { id: req.params.id },
    data: {
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
      ...(parsed.data.address ? { address: parsed.data.address } : {}),
    },
  });
  return res.json({ success: true, data: updated });
});

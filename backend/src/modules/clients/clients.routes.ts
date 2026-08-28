import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { getPolicyString, setPolicyString } from '../../common/policy-engine/policy-engine';

export const clientsRouter = Router();
clientsRouter.use(requireAuth, requireRole('HR_ADMIN', 'SYSTEM_ADMIN'));

/** 본사 좌표 조회 — "본사 복귀 자동감지" 기능의 기준 좌표. 미등록이면 그 기능은 비활성화된다. */
clientsRouter.get('/hq-location', async (_req, res) => {
  const lat = await getPolicyString('HQ_LATITUDE', '');
  const lng = await getPolicyString('HQ_LONGITUDE', '');
  return res.json({
    success: true,
    data: { latitude: lat ? Number(lat) : null, longitude: lng ? Number(lng) : null },
  });
});

const hqLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/** 본사 좌표 등록/수정 */
clientsRouter.put('/hq-location', async (req, res) => {
  const parsed = hqLocationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '위도/경도 값을 확인하세요.' } });
  }
  await setPolicyString('HQ_LATITUDE', String(parsed.data.latitude));
  await setPolicyString('HQ_LONGITUDE', String(parsed.data.longitude));
  return res.json({ success: true, data: parsed.data });
});

/** 고객사 목록 + 좌표 등록 여부 (위치대조 기능용 관리 화면). SAMPLE_ 테스트 고객사는 제외한다. */
clientsRouter.get('/', async (_req, res) => {
  const clients = await prisma.client.findMany({
    where: { name: { not: { startsWith: 'SAMPLE_' } } },
    orderBy: { name: 'asc' },
  });
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

const createClientSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
});

/** 신규 고객사 등록 — 지도에서 검색한 고객사명/주소/좌표를 그대로 넘기면 바로 생성된다. */
clientsRouter.post('/', async (req, res) => {
  const parsed = createClientSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '고객사명과 주소를 확인하세요.' } });
  }
  const created = await prisma.client.create({
    data: {
      name: parsed.data.name,
      address: parsed.data.address,
      latitude: parsed.data.latitude ?? null,
      longitude: parsed.data.longitude ?? null,
    },
  });
  return res.json({ success: true, data: created });
});

/** 고객사 삭제 — 배정된 직원이나 도착체크 이력이 있으면 막는다(데이터 무결성 보호). */
clientsRouter.delete('/:id', async (req, res) => {
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '고객사를 찾을 수 없습니다.' } });
  }
  const assignedCount = await prisma.user.count({ where: { assignedClientId: req.params.id } });
  if (assignedCount > 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'CLIENT_IN_USE', message: `이 고객사에 배정된 직원이 ${assignedCount}명 있어 삭제할 수 없습니다. 먼저 배정을 해제해주세요.` },
    });
  }
  const checkinCount = await prisma.residentCheckin.count({ where: { clientId: req.params.id } });
  if (checkinCount > 0) {
    return res.status(400).json({
      success: false,
      error: { code: 'CLIENT_HAS_HISTORY', message: '이 고객사에 도착체크 이력이 있어 삭제할 수 없습니다(근태기록 보존을 위함). 좌표만 비워두거나 이름을 정리하는 걸 권장드립니다.' },
    });
  }
  await prisma.client.delete({ where: { id: req.params.id } });
  return res.json({ success: true, data: { deleted: true } });
});

const updateCoordsSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  // 지도에서 검색해서 찾은 값이거나, 직접입력 저장에서 고객사명/주소를 같이 고친 경우 넘어온다.
  name: z.string().min(1).optional(),
  address: z.string().optional(),
});

/** 고객사 정보(고객사명/주소/좌표) 전체 수정 — "직접입력 저장"에서 한 줄 전체를 고칠 때 쓴다. */
clientsRouter.put('/:id/coordinates', async (req, res) => {
  const parsed = updateCoordsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '입력값을 확인하세요.' } });
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
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
      ...(parsed.data.address ? { address: parsed.data.address } : {}),
    },
  });
  return res.json({ success: true, data: updated });
});

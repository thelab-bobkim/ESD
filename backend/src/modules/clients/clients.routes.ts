import { createRouter } from '../../common/async-router';
import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { requireAuth, requireRole } from '../../common/guards/auth';
import { getPolicyString, setPolicyString, getPolicyJSON, setPolicyJSON } from '../../common/policy-engine/policy-engine';
import { recordAuditLog } from '../../common/audit';
import { findDuplicateGroups, normalizeAddress, looksLikeSameClient, haversineMeters } from './client-duplicates';
import { loadProposals, saveProposals, groupProposals, clusterOf } from './location-proposals';
import { sendPushToUser, isPushConfigured } from '../../common/push';

// 공인IP 한 줄 또는 "x.x.x.x/nn" CIDR 대역 표기 — 인터넷 회선이 여러 개라 공인IP가 수십 개인
// 사무실도 대역으로 묶어 몇 줄로 등록할 수 있게 CIDR도 허용한다(attendance.routes.ts의
// isRequestFromOfficeNetwork가 실제 판정에 사용, 2026-09-06).
const ipOrCidrPattern = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;

export const clientsRouter = createRouter();
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

/**
 * 사내망(공인IP) 허용 목록 조회/등록 — GPS가 실내에서 부정확하거나(신한이노플렉스 사무실 최대
 * 835m 오차 사례) 아예 확보가 안 되는 데스크탑 환경에서도, 등록된 사무실 공인IP로 접속했으면
 * GPS와 무관하게 "본사근무 위치확인 완료"로 처리해주는 보조수단이다(attendance.routes.ts의
 * isRequestFromOfficeNetwork 참고). 인터넷 회선이 여러 개라 공인IP가 수십 개인 사무실을 고려해
 * 개별 IP와 "x.x.x.x/nn" CIDR 대역 표기를 섞어서 등록할 수 있다(2026-09-06).
 */
clientsRouter.get('/hq-office-network', async (_req, res) => {
  const allowedIps = await getPolicyJSON<string[]>('HQ_ALLOWED_PUBLIC_IPS', []);
  return res.json({ success: true, data: { allowedIps } });
});

const hqOfficeNetworkSchema = z.object({
  allowedIps: z.array(z.string().trim().regex(ipOrCidrPattern, '"1.2.3.4" 또는 "1.2.3.0/24" 형식이어야 합니다.')).max(200),
});

clientsRouter.put('/hq-office-network', async (req, res) => {
  const parsed = hqOfficeNetworkSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_INPUT', message: parsed.error.issues[0]?.message ?? 'IP 목록 형식을 확인하세요.' },
    });
  }
  // 중복/빈 줄 정리.
  const cleaned = Array.from(new Set(parsed.data.allowedIps.map((s) => s.trim()).filter(Boolean)));
  await setPolicyJSON('HQ_ALLOWED_PUBLIC_IPS', cleaned);
  return res.json({ success: true, data: { allowedIps: cleaned } });
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

/**
 * 2026-10-13: 같은 고객사가 이름만 다르게 이중 등록된 경우(주소 동일)를 찾아 보여준다 — 조회 전용.
 * 각 고객사가 어디에 얼마나 쓰이는지(직원 배정·도착체크·프로젝트·담당자·공수 기록 수)를 같이 내려줘서,
 * 관리자가 "정확한 이름"을 고를 때 근거로 삼게 한다. 자동 삭제는 하지 않는다.
 */
clientsRouter.get('/duplicates', async (_req, res) => {
  const clients = await prisma.client.findMany({
    where: { name: { not: { startsWith: 'SAMPLE_' } } },
    select: { id: true, name: true, address: true, latitude: true, longitude: true },
    orderBy: { name: 'asc' },
  });
  const groups = findDuplicateGroups(clients);
  const ids = groups.flatMap((g) => g.clients.map((c) => c.id));
  const names = groups.flatMap((g) => g.clients.map((c) => c.name));
  const [assigned, checkins, projects, contacts, efforts] = ids.length
    ? await Promise.all([
        prisma.user.groupBy({ by: ['assignedClientId'], where: { assignedClientId: { in: ids } }, _count: { _all: true } }),
        prisma.residentCheckin.groupBy({ by: ['clientId'], where: { clientId: { in: ids } }, _count: { _all: true } }),
        prisma.project.groupBy({ by: ['clientId'], where: { clientId: { in: ids } }, _count: { _all: true } }),
        prisma.clientContact.groupBy({ by: ['clientId'], where: { clientId: { in: ids } }, _count: { _all: true } }),
        prisma.effortLog.groupBy({ by: ['clientName'], where: { clientName: { in: names } }, _count: { _all: true } }),
      ])
    : [[], [], [], [], []];
  const countOf = (rows: any[], key: string, value: string) => rows.find((r) => r[key] === value)?._count?._all ?? 0;
  return res.json({
    success: true,
    data: groups.map((g) => ({
      key: g.key,
      confidence: g.confidence,
      suggestedKeepId: g.suggestedKeepId,
      clients: g.clients.map((c) => ({
        id: c.id,
        name: c.name,
        address: c.address,
        hasCoordinates: c.latitude != null && c.longitude != null,
        // 남길 이름 후보와 같은 곳으로 보이는지 — 화면에서 "합칠 대상" 기본 체크에 쓴다.
        looksSameAsSuggested: c.id === g.suggestedKeepId || looksLikeSameClient(c, g.clients.find((x) => x.id === g.suggestedKeepId)!),
        usage: {
          assignedUsers: countOf(assigned as any[], 'assignedClientId', c.id),
          checkins: countOf(checkins as any[], 'clientId', c.id),
          projects: countOf(projects as any[], 'clientId', c.id),
          contacts: countOf(contacts as any[], 'clientId', c.id),
          effortLogs: countOf(efforts as any[], 'clientName', c.name),
        },
      })),
    })),
  });
});

const mergeSchema = z.object({
  keepId: z.string().uuid(),
  removeIds: z.array(z.string().uuid()).min(1).max(20),
  // 이전 공수 기록의 고객사명(문자열)도 남기는 이름으로 통일할지(기본 예). 아니오면 과거 기록은 원래 이름 그대로 둔다.
  renameEffortLogs: z.boolean().optional(),
});

/**
 * 중복 고객사 합치기 — 관리자가 남길 고객사(keepId)를 고르면, 지울 고객사(removeIds)의 연결(직원 배정·도착체크·프로젝트·담당자·
 * 공수 기록 이름)을 남길 쪽으로 옮긴 뒤 지운다. 모두 한 트랜잭션이라 중간에 실패하면 아무것도 바뀌지 않고, 감사 기록이 남는다.
 * 안전장치: 주소가 같은 고객사끼리만 합칠 수 있다(전혀 다른 곳을 실수로 합치지 못하게).
 */
clientsRouter.post('/merge', async (req, res) => {
  const parsed = mergeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '남길 고객사와 합칠 고객사를 확인하세요.' } });
  }
  const { keepId, removeIds } = parsed.data;
  const renameEffortLogs = parsed.data.renameEffortLogs !== false;
  if (removeIds.includes(keepId) || new Set(removeIds).size !== removeIds.length) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '남길 고객사를 합칠 대상에 넣을 수 없어요.' } });
  }
  const rows = await prisma.client.findMany({ where: { id: { in: [keepId, ...removeIds] } } });
  const keep = rows.find((c) => c.id === keepId);
  const removed = rows.filter((c) => removeIds.includes(c.id));
  if (!keep || removed.length !== removeIds.length) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '고객사를 찾을 수 없습니다. 목록을 새로고침해주세요.' } });
  }
  const keepAddress = normalizeAddress(keep.address);
  if (!keepAddress || removed.some((c) => normalizeAddress(c.address) !== keepAddress)) {
    return res.status(400).json({ success: false, error: { code: 'ADDRESS_MISMATCH', message: '주소가 서로 같은 고객사끼리만 합칠 수 있어요.' } });
  }

  const summary = { users: 0, checkins: 0, projects: 0, contactsMoved: 0, contactsMerged: 0, effortRenamed: 0, coordinatesCopied: false };
  // 남길 쪽에 좌표가 없는데 합칠 쪽에 있으면 그 좌표를 물려받는다 — 합친 뒤에 위치대조가 오히려 사라지면 안 된다.
  const donor = keep.latitude == null || keep.longitude == null ? removed.find((c) => c.latitude != null && c.longitude != null) : undefined;
  await prisma.$transaction(async (tx) => {
    if (donor) {
      await tx.client.update({ where: { id: keepId }, data: { latitude: donor.latitude, longitude: donor.longitude } });
      summary.coordinatesCopied = true;
    }
    const keepContacts = new Map<string, string>(
      (await tx.clientContact.findMany({ where: { clientId: keepId }, select: { id: true, name: true } })).map((c) => [c.name, c.id])
    );
    for (const r of removed) {
      const contacts = await tx.clientContact.findMany({ where: { clientId: r.id }, select: { id: true, name: true } });
      for (const c of contacts) {
        const sameNameId = keepContacts.get(c.name);
        if (sameNameId) {
          // 남길 쪽에 같은 이름의 담당자가 있으면 공수 기록의 담당자 연결만 그쪽으로 옮기고 이 담당자는 정리한다.
          await tx.effortLog.updateMany({ where: { contactId: c.id }, data: { contactId: sameNameId } });
          await tx.clientContact.delete({ where: { id: c.id } });
          summary.contactsMerged += 1;
        } else {
          await tx.clientContact.update({ where: { id: c.id }, data: { clientId: keepId } });
          keepContacts.set(c.name, c.id);
          summary.contactsMoved += 1;
        }
      }
      summary.users += (await tx.user.updateMany({ where: { assignedClientId: r.id }, data: { assignedClientId: keepId } })).count;
      summary.checkins += (await tx.residentCheckin.updateMany({ where: { clientId: r.id }, data: { clientId: keepId } })).count;
      summary.projects += (await tx.project.updateMany({ where: { clientId: r.id }, data: { clientId: keepId } })).count;
      if (renameEffortLogs && r.name !== keep.name) {
        summary.effortRenamed += (await tx.effortLog.updateMany({ where: { clientName: r.name }, data: { clientName: keep.name } })).count;
      }
      await tx.client.delete({ where: { id: r.id } });
    }
    await recordAuditLog({
      actorUserId: (req as any).authUser?.userId ?? null,
      actionType: 'CORRECT',
      targetType: 'client_merge',
      targetId: keepId,
      beforeValue: { removed: removed.map((c) => ({ id: c.id, name: c.name, address: c.address })) },
      afterValue: { keep: { id: keep.id, name: keep.name }, renameEffortLogs, ...summary },
    }, tx);
  });
  return res.json({ success: true, data: { keep: { id: keep.id, name: keep.name }, removed: removed.map((c) => c.name), ...summary } });
});

/**
 * 2026-10-13: 직원의 "등록된 고객사 위치가 실제와 달라요" 신청 목록 — 같은 고객사·가까운 위치끼리 묶어서 보여준다.
 * 제안 좌표는 서로 다른 직원이 올린 최신 위치의 평균이고, 현재 등록 좌표와의 거리·몇 명이 신청했는지를 함께 보여줘서 판단 근거로 쓴다.
 */
clientsRouter.get('/location-proposals', async (_req, res) => {
  const list = await loadProposals();
  const clusters = groupProposals(list);
  const ids = [...new Set(clusters.map((c) => c.clientId))];
  const clients = ids.length ? await prisma.client.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, address: true, latitude: true, longitude: true } }) : [];
  const byId = new Map(clients.map((c) => [c.id, c]));
  const data = clusters.map((c) => {
    const client = byId.get(c.clientId);
    const registered = client && client.latitude != null && client.longitude != null ? { lat: client.latitude, lng: client.longitude } : null;
    return {
      id: c.representative.id,
      clientId: c.clientId,
      clientName: client?.name ?? c.representative.clientName,
      clientExists: !!client,
      address: client?.address ?? '',
      createdAt: c.representative.createdAt,
      userNames: c.userNames,
      userCount: c.userCount,
      requestCount: c.members.length,
      notes: [...new Set(c.members.map((m) => m.note).filter((n): n is string => !!n))].slice(0, 3),
      distanceFromRegisteredMeters: registered ? Math.round(haversineMeters(c.centerLat, c.centerLng, registered.lat, registered.lng)) : null,
      proposedLat: c.centerLat,
      proposedLng: c.centerLng,
      registeredLat: registered?.lat ?? null,
      registeredLng: registered?.lng ?? null,
    };
  });
  return res.json({ success: true, data });
});

async function notifyProposers(userIds: string[], body: string) {
  if (!isPushConfigured()) return;
  for (const id of userIds) {
    try {
      await sendPushToUser(id, { title: 'DSTI-TSB', body, url: '/' });
    } catch (e) {
      console.error('[location-proposal] push failed', e);
    }
  }
}

/** 신청 승인 — 같은 묶음의 신청들의 평균 위치를 그 고객사의 등록 좌표로 반영하고, 신청한 직원들에게 알린다. */
clientsRouter.post('/location-proposals/:id/approve', async (req, res) => {
  const list = await loadProposals();
  const cluster = clusterOf(list, req.params.id);
  if (!cluster) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '이미 처리되었거나 없는 신청이에요. 목록을 새로고침해주세요.' } });
  }
  const client = await prisma.client.findUnique({ where: { id: cluster.clientId } });
  const memberIds = new Set(cluster.members.map((m) => m.id));
  const remaining = list.filter((p) => !memberIds.has(p.id));
  if (!client) {
    await saveProposals(remaining);
    return res.status(404).json({ success: false, error: { code: 'CLIENT_NOT_FOUND', message: '그 고객사가 이미 삭제되어 신청을 정리했어요.' } });
  }
  const before = { latitude: client.latitude, longitude: client.longitude };
  await prisma.client.update({ where: { id: client.id }, data: { latitude: cluster.centerLat, longitude: cluster.centerLng } });
  await saveProposals(remaining);
  await recordAuditLog({
    actorUserId: (req as any).authUser?.userId ?? null,
    actionType: 'CORRECT',
    targetType: 'client_location_proposal_approved',
    targetId: client.id,
    beforeValue: { clientName: client.name, ...before },
    afterValue: { latitude: cluster.centerLat, longitude: cluster.centerLng, requestCount: cluster.members.length, userCount: cluster.userCount },
  });
  await notifyProposers([...new Set(cluster.members.map((m) => m.userId))], `'${client.name}' 위치가 수정되었어요. 다시 등록해 주세요.`);
  return res.json({ success: true, data: { clientName: client.name, latitude: cluster.centerLat, longitude: cluster.centerLng, userCount: cluster.userCount } });
});

const rejectSchema = z.object({ reason: z.string().trim().max(100).optional() });

/** 신청 반려 — 고객사 좌표는 그대로 두고 신청만 정리하며, 신청한 직원들에게 알린다. */
clientsRouter.post('/location-proposals/:id/reject', async (req, res) => {
  const parsed = rejectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '사유는 100자 이내로 입력해주세요.' } });
  }
  const list = await loadProposals();
  const cluster = clusterOf(list, req.params.id);
  if (!cluster) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '이미 처리되었거나 없는 신청이에요. 목록을 새로고침해주세요.' } });
  }
  const memberIds = new Set(cluster.members.map((m) => m.id));
  await saveProposals(list.filter((p) => !memberIds.has(p.id)));
  const clientName = cluster.representative.clientName;
  await recordAuditLog({
    actorUserId: (req as any).authUser?.userId ?? null,
    actionType: 'CORRECT',
    targetType: 'client_location_proposal_rejected',
    targetId: cluster.clientId,
    afterValue: { clientName, requestCount: cluster.members.length, userCount: cluster.userCount, reason: parsed.data.reason ?? null },
  });
  await notifyProposers([...new Set(cluster.members.map((m) => m.userId))], `'${clientName}' 위치 수정 신청은 반영되지 않았어요${parsed.data.reason ? ` (${parsed.data.reason})` : ''}. 현장 위치를 다시 확인해 주세요.`);
  return res.json({ success: true, data: { clientName } });
});

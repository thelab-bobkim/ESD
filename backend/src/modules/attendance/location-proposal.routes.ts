import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { recordAuditLog } from '../../common/audit';
import { sendPushToUser, isPushConfigured } from '../../common/push';
import { checkLocationMatch } from '../../common/location';
import { haversineMeters } from '../clients/client-duplicates';
import {
  loadProposals, saveProposals, upsertProposal, newProposalId, roundCoord,
  PROPOSAL_MAX_ACCURACY_METERS, PROPOSAL_MAX_PIN_DISTANCE_METERS, MAX_PROPOSALS_PER_USER,
  type LocationProposal,
} from '../clients/location-proposals';

/**
 * 2026-10-13: 직원용 "등록된 고객사 위치가 실제와 달라요" 신청 (POST /attendance/location-proposals).
 * 위치 불일치로 등록이 막혔을 때, 직원이 지도에서 확인한 지금 위치가 그 고객사의 실제 위치라고 알리면 관리자에게 전달된다.
 * 이 요청만으로는 고객사 좌표가 바뀌지 않는다 — 관리자 승인(고객사 위치관리 > 위치 수정 신청)이 있어야 반영된다.
 */
const bodySchema = z.object({
  clientId: z.string().uuid().optional(),
  clientName: z.string().trim().min(1).max(100),
  status: z.enum(['CLIENT_WORK', 'CLIENT_MEETING']),
  location: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  confirmedLocation: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  accuracyMeters: z.number().min(0).max(100000).optional(),
  note: z.string().trim().max(200).optional(),
});

export function registerLocationProposalRoutes(router: any) {
  router.post('/location-proposals', async (req: any, res: any) => {
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '신청 내용을 확인해 주세요. (고객사, 지금 위치)' } });
    }
    const { clientId, clientName, status, location, confirmedLocation, accuracyMeters, note } = parsed.data;
    const userId = req.authUser!.userId as string;

    if (accuracyMeters == null || accuracyMeters > PROPOSAL_MAX_ACCURACY_METERS) {
      return res.status(400).json({
        success: false,
        error: { code: 'GPS_ACCURACY_LOW', message: `GPS 오차가 커서(${accuracyMeters == null ? '측정값 없음' : `약 ${Math.round(accuracyMeters)}m`}) 위치 수정을 신청할 수 없어요. 건물 밖에서 위치를 다시 측정한 뒤 신청해 주세요.` },
      });
    }
    // 지도에서 확정한 위치는 이번에 실제 측정된 GPS 지점 근처여야 한다 — 임의의 장소를 찍어 신청하지 못하게 한다(등록 보정과 같은 기준).
    const pinDistance = Math.round(haversineMeters(location.lat, location.lng, confirmedLocation.lat, confirmedLocation.lng));
    if (pinDistance > PROPOSAL_MAX_PIN_DISTANCE_METERS) {
      return res.status(400).json({
        success: false,
        error: { code: 'LOCATION_CORRECTION_TOO_FAR', message: `처음 측정된 내 위치에서 ${pinDistance}m 떨어져 있어 신청할 수 없어요. 실제 계신 곳 근처에서 다시 시도해주세요.` },
      });
    }

    const client = clientId
      ? await prisma.client.findUnique({ where: { id: clientId } })
      : await prisma.client.findFirst({ where: { name: { equals: clientName, mode: 'insensitive' } } });
    if (!client || client.latitude == null || client.longitude == null) {
      return res.status(404).json({ success: false, error: { code: 'CLIENT_NOT_FOUND', message: '위치가 등록된 고객사를 찾을 수 없어요. 고객사 목록에서 선택했는지 확인해 주세요.' } });
    }
    const already = checkLocationMatch(confirmedLocation, client);
    if (already?.locationMatch) {
      return res.status(400).json({
        success: false,
        error: { code: 'ALREADY_MATCHED', message: `이미 등록된 '${client.name}' 위치와 가까워요(약 ${already.locationDistanceMeters}m). 수정 신청 없이 "여기가 맞습니다 · 등록 계속"으로 등록할 수 있어요.` },
      });
    }

    const list = await loadProposals();
    const mine = list.filter((p) => p.userId === userId && p.clientId !== client.id);
    if (mine.length >= MAX_PROPOSALS_PER_USER) {
      return res.status(429).json({ success: false, error: { code: 'TOO_MANY_PROPOSALS', message: '처리 대기 중인 위치 수정 신청이 너무 많아요. 관리자가 처리한 뒤 다시 신청해 주세요.' } });
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    const proposal: LocationProposal = {
      id: newProposalId(),
      userId,
      userName: user?.name ?? '',
      createdAt: new Date().toISOString(),
      status,
      clientId: client.id,
      clientName: client.name,
      lat: roundCoord(confirmedLocation.lat),
      lng: roundCoord(confirmedLocation.lng),
      accuracyMeters: Math.round(accuracyMeters),
      distanceMeters: Math.round(haversineMeters(confirmedLocation.lat, confirmedLocation.lng, client.latitude, client.longitude)),
      note: note || null,
    };
    await saveProposals(upsertProposal(list, proposal));
    await recordAuditLog({
      actorUserId: userId, actionType: 'STATUS_CHANGE', targetType: 'client_location_proposal', targetId: client.id,
      afterValue: { proposalId: proposal.id, clientName: client.name, distanceMeters: proposal.distanceMeters, status },
    });

    // 관리자에게 알림(실패해도 신청 자체는 성공으로 둔다).
    try {
      if (isPushConfigured()) {
        const admins = await prisma.user.findMany({
          where: { employmentStatus: 'ACTIVE', userRoles: { some: { role: { code: { in: ['HR_ADMIN', 'SYSTEM_ADMIN'] } } } } },
          select: { id: true },
        });
        for (const a of admins) {
          await sendPushToUser(a.id, { title: 'DSTI-TSB', body: `'${client.name}' 위치 수정 신청이 들어왔어요(${proposal.userName}). 관리자 > 고객사 위치관리 > 위치 수정 신청에서 확인해 주세요.`, url: '/admin/clients' });
        }
      }
    } catch (e) {
      console.error('[location-proposal] admin push failed', e);
    }
    return res.json({ success: true, data: { id: proposal.id, clientName: client.name, distanceMeters: proposal.distanceMeters } });
  });
}

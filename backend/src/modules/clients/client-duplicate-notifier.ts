import { prisma } from '../../common/prisma';
import { sendPushToUser, isPushConfigured } from '../../common/push';
import { findDuplicateGroups } from './client-duplicates';

/**
 * 2026-10-13: 매일 오전 8시(KST)에 고객사 위치관리 DB를 훑어, 같은 주소로 이중 등록된 고객사(예: '생물' / '국립생물자원관')가
 * 있으면 인사·시스템 관리자에게 푸시로 알린다. 자동으로 지우지는 않는다 — 어떤 이름이 정확한지는 관리자가 고르고
 * (관리자 > 고객사 위치관리 > 중복 고객사), 합치기는 연결(프로젝트·담당자·공수 이름)을 옮긴 뒤 처리한다.
 * 평일만 보낸다. 해결되면(중복이 없어지면) 알림도 멈춘다.
 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const NOTIFY_HOUR_KST = 8;

let lastNotifiedDateKey: string | null = null;

function kstParts(now: Date) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return { hour: kst.getUTCHours(), dow: kst.getUTCDay(), key: kst.toISOString().slice(0, 10) };
}

/** 한 번 점검해서(알림 대상이면) 관리자에게 푸시를 보낸다. 테스트하기 쉽게 분리했다. */
export async function runClientDuplicateCheck(now: Date = new Date()): Promise<{ notified: number; groups: number }> {
  const clients = await prisma.client.findMany({
    where: { name: { not: { startsWith: 'SAMPLE_' } } },
    select: { id: true, name: true, address: true, latitude: true, longitude: true },
  });
  const high = findDuplicateGroups(clients).filter((g) => g.confidence === 'HIGH');
  if (high.length === 0) return { notified: 0, groups: 0 };
  const admins = await prisma.user.findMany({
    where: { employmentStatus: 'ACTIVE', userRoles: { some: { role: { code: { in: ['HR_ADMIN', 'SYSTEM_ADMIN'] } } } } },
    select: { id: true },
  });
  const example = high[0].clients.map((c) => `'${c.name}'`).join(' / ');
  const body = `같은 주소로 이중 등록된 고객사가 ${high.length}건 있어요 (예: ${example}). 관리자 > 고객사 위치관리 > 중복 고객사에서 맞는 이름을 골라 정리해주세요.`;
  for (const a of admins) {
    await sendPushToUser(a.id, { title: 'DSTI-TSB', body, url: '/admin/clients' });
  }
  return { notified: admins.length, groups: high.length };
}

export function startClientDuplicateNotifier() {
  setInterval(async () => {
    try {
      if (!isPushConfigured()) return;
      const now = new Date();
      const { hour, dow, key } = kstParts(now);
      if (hour !== NOTIFY_HOUR_KST || dow === 0 || dow === 6) return;
      if (lastNotifiedDateKey === key) return;
      lastNotifiedDateKey = key; // 실패해도 같은 날 반복 시도하지 않는다(알림이 쏟아지는 것 방지).
      const r = await runClientDuplicateCheck(now);
      if (r.groups > 0) {
        // eslint-disable-next-line no-console
        console.log(`[ClientDuplicateCheck] 중복 고객사 ${r.groups}건 — 관리자 ${r.notified}명에게 알림`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ClientDuplicateCheck] 오류:', err);
    }
  }, CHECK_INTERVAL_MS);
}

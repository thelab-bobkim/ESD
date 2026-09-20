import { prisma } from './prisma';

/**
 * 2026-09-20: "감사인" 권한(대표이사 요청) 부트스트랩.
 *
 * 이 프로젝트는 정식 마이그레이션 대신 `prisma db push`로 스키마를 동기화하고(Dockerfile 참고),
 * Role 테이블의 실제 행(EMPLOYEE/TEAM_LEAD/HR_ADMIN/SYSTEM_ADMIN/PILOT_MANAGER)은 최초 설치 때
 * 수동으로 넣어둔 것들이라 이 코드에는 그 흔적이 없다. 새 RoleCode 값(AUDITOR)을 추가할 때마다
 * 매번 운영 DB에 수동으로 INSERT를 해야 한다면 실수하기 쉬우므로, 서버 시작 시 AUDITOR 행이
 * 없으면 만들어두기만 하는 최소한의 부트스트랩을 둔다.
 *
 * 기존 역할(EMPLOYEE 등)은 절대 건드리지 않는다 — 오직 AUDITOR 하나만, 없을 때만 생성한다
 * (이미 있으면 아무것도 안 함 — 이름을 나중에 관리자가 바꿔도 여기서 되돌리지 않도록).
 */
export async function ensureAuditorRole(): Promise<void> {
  const existing = await prisma.role.findUnique({ where: { code: 'AUDITOR' } });
  if (existing) return;
  await prisma.role.create({ data: { code: 'AUDITOR', name: '감사인' } });
  // eslint-disable-next-line no-console
  console.log('[EnsureRoles] AUDITOR 역할이 없어 새로 생성했습니다.');
}

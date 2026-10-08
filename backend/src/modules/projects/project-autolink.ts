import { prisma } from '../../common/prisma';
import { normalizeName, isInternalClientKey } from './project-backfill-plan';
import { nextProjectCode } from './project-code';

/**
 * 2026-10-08: 직원이 공수를 등록할 때 프로젝트를 직접 고르지 않아도, "등록된(clients 테이블) 고객사"
 * 이면 그 고객사의 진행 중 프로젝트에 자동으로 연결한다(없으면 새로 만든다). 자유입력으로 만든
 * 이상한 이름으로는 절대 프로젝트를 만들지 않는다(사용자 결정).
 *
 * 이 함수는 어떤 경우에도 예외를 밖으로 던지지 않는다 — 자동 연결이 실패해도 직원의 공수 등록
 * 자체는 막지 않는다(호출부에서 null이면 기존처럼 프로젝트 없이 저장).
 */

const OPEN_STATUSES = ['ACTIVE', 'PLANNED', 'ON_HOLD'] as const;

function kstDateOnly(): Date {
  const kst = new Date(Date.now() + 9 * 3600_000);
  return new Date(`${kst.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

async function findRegisteredClient(clientId: string | undefined, clientName: string): Promise<{ id: string; name: string } | null> {
  if (clientId) {
    const c = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
    if (c) return c;
  }
  const trimmed = clientName.trim();
  if (!trimmed) return null;
  const exact = await prisma.client.findMany({
    where: { name: { equals: trimmed, mode: 'insensitive' } },
    select: { id: true, name: true },
    take: 2,
  });
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null; // 같은 이름 지점이 여러 곳 — 어느 곳인지 특정 불가
  const key = normalizeName(trimmed);
  if (!key) return null;
  const all = await prisma.client.findMany({ select: { id: true, name: true } });
  const matches = all.filter((c: { id: string; name: string }) => normalizeName(c.name) === key);
  return matches.length === 1 ? matches[0] : null;
}

export interface AutoProjectInput {
  userId: string;
  clientId?: string;
  clientName: string;
  /** false면 이미 있는 프로젝트에만 연결하고 새로 만들지는 않는다(예: 고객사미팅). */
  allowCreate: boolean;
}

export async function resolveAutoProject(input: AutoProjectInput): Promise<{ id: string; name: string } | null> {
  try {
    const client = await findRegisteredClient(input.clientId, input.clientName);
    if (!client) return null;
    const key = normalizeName(client.name);
    if (!key || isInternalClientKey(key)) return null;

    // 1) 이 고객사의 진행 중 프로젝트 — 본인이 참여 중인 것을 우선한다.
    const open = await prisma.project.findMany({
      where: { clientId: client.id, status: { in: [...OPEN_STATUSES] } },
      select: { id: true, name: true, members: { where: { userId: input.userId }, select: { id: true } }, managerId: true },
      orderBy: { updatedAt: 'desc' },
    });
    let target = open.find((p: { members: unknown[]; managerId: string | null }) => p.members.length > 0 || p.managerId === input.userId) ?? open[0] ?? null;

    // 2) 진행 중인 게 없고 완료된 프로젝트만 있으면 다시 진행 상태로 되돌린다(고객사 1곳 = 프로젝트 1개).
    if (!target && input.allowCreate) {
      const done = await prisma.project.findFirst({
        where: { clientId: client.id, status: 'COMPLETED' },
        select: { id: true, name: true, managerId: true },
        orderBy: { updatedAt: 'desc' },
      });
      if (done) {
        await prisma.project.update({ where: { id: done.id }, data: { status: 'ACTIVE', endDate: null } });
        target = { ...done, members: [] };
      }
    }

    // 3) 아무것도 없으면 새로 만든다.
    if (!target && input.allowCreate) {
      for (let attempt = 0; attempt < 3 && !target; attempt++) {
        try {
          const created = await prisma.project.create({
            data: {
              code: await nextProjectCode(prisma),
              name: client.name,
              clientId: client.id,
              status: 'ACTIVE',
              startDate: kstDateOnly(),
              description: '직원 공수 등록 시 자동 생성된 프로젝트(고객사 1곳 = 프로젝트 1개)',
              createdByUserId: input.userId,
            },
            select: { id: true, name: true },
          });
          target = { ...created, members: [], managerId: null };
        } catch (e: any) {
          if (e?.code !== 'P2002') throw e; // 코드 충돌이면 다시 시도
        }
      }
    }
    if (!target) return null;

    // 4) 참여자로 등록(이미 있으면 그대로 둔다).
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: target.id, userId: input.userId } },
      update: {},
      create: { projectId: target.id, userId: input.userId, role: 'MEMBER' },
    });
    return { id: target.id, name: target.name };
  } catch (e) {
    console.error('[project-autolink] 자동 연결 실패(공수 등록은 계속 진행):', e);
    return null;
  }
}

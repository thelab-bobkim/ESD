import { prisma } from './prisma';
import type { AuditActionType, Prisma } from '@prisma/client';

interface AuditInput {
  actorUserId?: string | null;
  actionType: AuditActionType;
  targetType: string;
  targetId?: string | null;
  beforeValue?: unknown;
  afterValue?: unknown;
  ipAddress?: string | null;
}

/**
 * 감사로그는 append-only. 이 함수 외에 audit_logs 테이블에 쓰기를 수행하는 코드가 없어야 한다.
 * 관리자 조회(VIEW), 상태변경, 승인/반려, 정정, 정책값 변경, 위치 상세조회 시 반드시 호출한다.
 */
/**
 * 2026-09-30 수정(Medium): 트랜잭션 안에서 감사로그를 남겨야 하는 경우(승인 처리 등)를 위해
 * 클라이언트를 주입받을 수 있게 한다 — 기본값은 전역 prisma라 기존 호출부는 그대로 동작한다.
 */
export async function recordAuditLog(input: AuditInput, client: Prisma.TransactionClient = prisma) {
  await client.auditLog.create({
    data: {
      actorUserId: input.actorUserId ?? null,
      actionType: input.actionType,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      beforeValue: input.beforeValue as any,
      afterValue: input.afterValue as any,
      ipAddress: input.ipAddress ?? null,
    },
  });
}

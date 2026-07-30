import { prisma } from './prisma';
import type { AuditActionType } from '@prisma/client';

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
export async function recordAuditLog(input: AuditInput) {
  await prisma.auditLog.create({
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

import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

/**
 * 2026-11-01 보안수정: 권한(UserRole)을 회수하는 곳에서는 반드시 이 함수를 같이 호출한다.
 * requireAuth가 매 요청마다 DB의 tokenVersion과 토큰 속 값을 비교하므로, 올리는 즉시 그 사용자의
 * 기존 토큰이 전부 무효화된다(회수 후에도 토큰이 최대 7일 살아있던 구멍을 막는다).
 * 권한 '부여'에는 호출하지 않는다 — 부여는 권한 상승 경로가 아니고(로그인 시 roles를 새로 읽음),
 * 올리면 근무 중인 직원이 강제 로그아웃되어 출퇴근 기록이 끊긴다.
 */
type UserTable = Pick<Prisma.TransactionClient, 'user'>;

export async function bumpTokenVersion(userId: string, db: UserTable = prisma): Promise<void> {
  await db.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
}

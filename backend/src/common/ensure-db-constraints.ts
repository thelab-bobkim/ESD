import { prisma } from './prisma';

/**
 * 2026-09-30 추가(M-14): NULL이 들어가는 복합 유니크 제약의 구멍을 DB 수준에서 막는다.
 *
 * - PolicySetting @@unique([key, scopeDepartmentId]), UserRole @@unique([userId, roleId, scopeDepartmentId])는
 *   scopeDepartmentId가 NULL(=전사/무범위)인 행끼리는 PostgreSQL이 "서로 다른 값"으로 취급해서
 *   유니크가 전혀 걸리지 않았다 — 동시 요청이나 재실행 시 같은 전사 정책값/같은 역할이 중복 생성될 수 있었고
 *   (policy.routes.ts / users.routes.ts 주석에 이미 인지돼 있던 문제), 중복되면 어느 값이 적용될지 불확정이다.
 * - 스키마 컬럼을 NOT NULL + sentinel로 바꾸는 방식은 기존 조회 코드 전부를 고쳐야 하고 데이터 마이그레이션
 *   위험이 크다. 대신 "scopeDepartmentId IS NULL"인 행에만 걸리는 부분 유니크 인덱스를 추가한다 —
 *   코드 변경 없이 DB가 중복을 거부한다.
 * - 이 프로젝트는 migrate 대신 db push를 쓰고 Prisma 스키마는 부분 인덱스를 표현하지 못하므로, 서버 부팅 시
 *   멱등(IF NOT EXISTS)으로 만든다. 이미 중복된 행이 있으면 인덱스 생성이 실패하므로, 먼저 가장 최근 1건만
 *   남기고 정리한다(정책값: updatedAt 최신, 역할: 아무거나 1건 — 내용이 완전히 같으므로 손실 없음).
 */
export async function ensureDbConstraints(): Promise<void> {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`
      DELETE FROM policy_settings p
       USING policy_settings q
       WHERE p.scope_department_id IS NULL AND q.scope_department_id IS NULL
         AND p.key = q.key
         AND (p.updated_at < q.updated_at OR (p.updated_at = q.updated_at AND p.id < q.id))
    `),
    prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS policy_settings_key_global_uniq
        ON policy_settings (key) WHERE scope_department_id IS NULL
    `),
    prisma.$executeRawUnsafe(`
      DELETE FROM user_roles a
       USING user_roles b
       WHERE a.scope_department_id IS NULL AND b.scope_department_id IS NULL
         AND a.user_id = b.user_id AND a.role_id = b.role_id AND a.id < b.id
    `),
    prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS user_roles_user_role_global_uniq
        ON user_roles (user_id, role_id) WHERE scope_department_id IS NULL
    `),
  ]);
}

-- ESD 2.0 Phase 1: 프로젝트/Task 관리 + EffortLog 연결
-- (2026-10-01 갱신: Genspark 0001-0008 패치의 M-4 "핫 쿼리 인덱스 8종"을 같은 migration에 통합 —
--  8번 섹션 참고. GPT 패치와 Genspark 패치를 하나의 배포로 합치면서, 스키마에 영향을 주는
--  모든 변경사항을 이 한 파일에 모아두는 편이 "migrate deploy 한 번으로 둘 다 반영"에 더 안전하다고
--  판단함. M-14(부분 유니크 인덱스)는 스키마가 아니라 서버 부팅 코드가 직접 처리 — 9번 섹션 참고.)
--
-- 중요: 이 SQL은 "npx prisma migrate dev --name esd2_project_phase1"을 실제로 실행했을 때 Prisma가
-- 생성할 내용을 스키마 변경사항에 맞춰 수작업으로 재현한 것입니다(이 검증 환경은 사내망 정책상
-- Prisma 엔진 바이너리를 내려받을 수 없어 CLI를 직접 실행하지 못했습니다 — 최종 보고서의
-- "Backend build 결과" 절 참고). 실제 배포 전에는 반드시 스테이징 DB에서
-- "npx prisma migrate dev --name esd2_project_phase1"을 직접 실행해 Prisma가 생성하는 SQL과
-- 이 파일을 대조 확인하십시오.
--
-- 전제조건(중요): 이 리포지토리에는 prisma/migrations 디렉터리가 기존에 없었습니다 — 지금까지
-- "prisma db push"로 운영 DB 스키마를 관리해 온 것으로 보입니다. 이 상태에서 바로
-- "npx prisma migrate dev"를 실행하면, Prisma는 "기존에 적용된 migration이 하나도 없다"고
-- 판단해 현재 schema.prisma 전체(이미 운영에 있는 기존 테이블 포함)를 처음부터 새로 만드는
-- migration을 생성하려고 시도하며, 이를 이미 테이블이 존재하는 DB에 적용하면 "relation already
-- exists" 오류로 즉시 실패합니다. 아래 순서를 반드시 먼저 거치십시오.
--
--   1) 스테이징 DB(운영과 동일한 현재 스키마 상태)에서:
--      npx prisma migrate dev --create-only --name baseline_a10b7c8
--      (현재 전체 스키마를 "처음부터 생성"하는 내용의 SQL이 생성됩니다 — 실행하지 않습니다)
--   2) 그 baseline migration을 "이미 적용된 것"으로만 기록합니다(SQL은 실행 안 함):
--      npx prisma migrate resolve --applied 20261001_baseline_a10b7c8  (실제 생성된 폴더명 사용)
--   3) 그 다음에야 이 esd2_project_phase1 migration을 생성/적용합니다:
--      npx prisma migrate dev --name esd2_project_phase1
--   4) 운영 DB에도 동일하게 1~2단계를 먼저 거친 뒤, "npx prisma migrate deploy"로 이 migration만
--      반영합니다.
--
-- 이 파일 자체는 1~2단계(baseline)가 이미 끝났다는 전제 하에, 신규로 추가되는 부분만 담고 있습니다.
-- 기존 테이블(users, effort_logs 등)은 건드리지 않고, 새 테이블 추가 / effort_logs에 컬럼 2개
-- 추가(nullable) / 인덱스 추가 / enum 값 1개 추가만 수행합니다 — 기존 데이터 삭제·변경 없음.

-- 1) 신규 enum 타입
CREATE TYPE "ProjectStatus" AS ENUM ('PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');
CREATE TYPE "ProjectPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');
CREATE TYPE "ProjectTaskStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE');

-- 2) 기존 enum에 값 추가(감사로그 actionType 구분용) — 기존 값은 그대로, 추가만 함(안전).
-- 참고: PostgreSQL은 "ALTER TYPE ... ADD VALUE"로 추가한 값을 같은 트랜잭션 안에서 바로
-- INSERT 등으로 사용하는 것은 막지만(enum 값이 아직 커밋 전이라서), 이 migration 안에서는 그
-- 값을 사용하는 DML이 없으므로 안전합니다. 다만 "npx prisma migrate dev"가 이를 생성할 때
-- 별도 migration으로 분리할 수도 있습니다 — 실행 시 이 줄에서만 오류가 나면, 이 한 줄만 먼저
-- 단독 migration으로 적용한 뒤 나머지를 적용하십시오.
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'PROJECT_CHANGE';

-- 3) projects 테이블
CREATE TABLE "projects" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client_id" TEXT,
    "status" "ProjectStatus" NOT NULL DEFAULT 'PLANNED',
    "priority" "ProjectPriority" NOT NULL DEFAULT 'NORMAL',
    "difficulty" INTEGER NOT NULL DEFAULT 3,
    "planned_minutes" INTEGER,
    "start_date" DATE,
    "end_date" DATE,
    "description" TEXT,
    "manager_id" TEXT,
    "created_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "projects_code_key" ON "projects"("code");
CREATE INDEX "projects_status_idx" ON "projects"("status");
CREATE INDEX "projects_manager_id_idx" ON "projects"("manager_id");
CREATE INDEX "projects_client_id_idx" ON "projects"("client_id");

-- 4) project_members 테이블
CREATE TABLE "project_members" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "allocation_pct" INTEGER NOT NULL DEFAULT 100,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "project_members_project_id_user_id_key" ON "project_members"("project_id", "user_id");
CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");

-- 5) project_tasks 테이블
CREATE TABLE "project_tasks" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ProjectTaskStatus" NOT NULL DEFAULT 'TODO',
    "priority" "ProjectPriority" NOT NULL DEFAULT 'NORMAL',
    "difficulty" INTEGER NOT NULL DEFAULT 3,
    "assignee_id" TEXT,
    "planned_minutes" INTEGER,
    "due_date" DATE,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_tasks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "project_tasks_project_id_status_idx" ON "project_tasks"("project_id", "status");
CREATE INDEX "project_tasks_assignee_id_status_idx" ON "project_tasks"("assignee_id", "status");
CREATE INDEX "project_tasks_due_date_idx" ON "project_tasks"("due_date");

-- 6) effort_logs: 기존 테이블에 nullable 컬럼 2개만 추가 — 과거 데이터는 NULL로 남고 그대로 조회됨.
ALTER TABLE "effort_logs" ADD COLUMN "project_id" TEXT;
ALTER TABLE "effort_logs" ADD COLUMN "task_id" TEXT;

CREATE INDEX "effort_logs_user_id_work_date_idx" ON "effort_logs"("user_id", "work_date");
CREATE INDEX "effort_logs_project_id_work_date_idx" ON "effort_logs"("project_id", "work_date");
CREATE INDEX "effort_logs_task_id_work_date_idx" ON "effort_logs"("task_id", "work_date");

-- 7) 외래키 제약 (모두 기존 테이블을 삭제/변경하지 않는 ADD CONSTRAINT)
ALTER TABLE "projects" ADD CONSTRAINT "projects_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "project_tasks" ADD CONSTRAINT "project_tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "effort_logs" ADD CONSTRAINT "effort_logs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "effort_logs" ADD CONSTRAINT "effort_logs_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "project_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ══════════════════════════════════════════════════════════════════════════════
-- 8) 2026-10-01 추가: Genspark 0001-0008 패치(M-4, "핫 쿼리 인덱스 8종")를 ESD2.0과 같은
-- migration으로 통합한다. 전부 기존 테이블/컬럼에 인덱스만 추가하는 것으로, 데이터 변경이나
-- 컬럼 추가/삭제는 없다(IF NOT EXISTS로 멱등 처리 — 이미 생성돼 있으면 건너뜀).
-- 각 인덱스가 어떤 문제를 해결하는지는 schema.prisma의 해당 모델 주석(2026-09-30 추가) 참고.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS "attendance_records_work_date_idx" ON "attendance_records"("work_date");
CREATE INDEX IF NOT EXISTS "attendance_correction_requests_attendance_record_id_status_idx" ON "attendance_correction_requests"("attendance_record_id", "status");
CREATE INDEX IF NOT EXISTS "break_sessions_attendance_record_id_idx" ON "break_sessions"("attendance_record_id");
CREATE INDEX IF NOT EXISTS "status_change_logs_user_id_changed_at_idx" ON "status_change_logs"("user_id", "changed_at");
CREATE INDEX IF NOT EXISTS "status_change_logs_status_changed_at_idx" ON "status_change_logs"("status", "changed_at");
CREATE INDEX IF NOT EXISTS "resident_checkins_user_id_checkin_at_idx" ON "resident_checkins"("user_id", "checkin_at");
CREATE INDEX IF NOT EXISTS "approval_requests_status_requested_at_idx" ON "approval_requests"("status", "requested_at");
CREATE INDEX IF NOT EXISTS "audit_logs_created_at_idx" ON "audit_logs"("created_at");
CREATE INDEX IF NOT EXISTS "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");
-- EffortLog의 나머지 M-4 인덱스(userId+workDate는 위 6)에서 이미 ESD2.0 이름으로 생성됨 — 중복 방지로 제외).
CREATE INDEX IF NOT EXISTS "effort_logs_user_id_source_status_start_time_idx" ON "effort_logs"("user_id", "source_status", "start_time");
CREATE INDEX IF NOT EXISTS "effort_logs_end_time_idx" ON "effort_logs"("end_time");

-- 9) 2026-10-01 추가: Genspark M-14(NULL 복합유니크 구멍) — 스키마가 아니라 서버 부팅 시
-- common/ensure-db-constraints.ts가 "중복 정리 + 부분 유니크 인덱스(IF NOT EXISTS)"를 멱등으로
-- 직접 실행한다(prisma db push 기반 프로젝트라 부분 인덱스를 스키마에 표현할 수 없어 택한 방식 —
-- Genspark 패치 원문 그대로 유지). 이 migration에서는 별도로 손대지 않는다. 배포 후 다음으로 재확인:
--   SELECT indexname FROM pg_indexes WHERE indexname IN
--     ('policy_settings_key_global_uniq', 'user_roles_user_role_global_uniq');

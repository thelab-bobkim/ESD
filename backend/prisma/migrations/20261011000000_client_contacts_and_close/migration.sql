-- 2026-10-11: 고객사 담당자 / 퇴근 위치 확인 결과 / 자동 마무리 표식 (추가만 하는 변경 — 기존 데이터는 건드리지 않음)
-- 모든 문장이 IF NOT EXISTS 이므로 여러 번 실행해도 안전하다(수동 적용 후 migrate deploy 가 다시 실행해도 무해).

CREATE TABLE IF NOT EXISTS "client_contacts" (
  "id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "department" TEXT,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3),
  "use_count" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "client_contacts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "client_contacts_client_id_name_key" ON "client_contacts"("client_id", "name");
CREATE INDEX IF NOT EXISTS "client_contacts_client_id_last_used_at_idx" ON "client_contacts"("client_id", "last_used_at");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_contacts_client_id_fkey') THEN
    ALTER TABLE "client_contacts"
      ADD CONSTRAINT "client_contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "effort_logs"
  ADD COLUMN IF NOT EXISTS "contact_id" TEXT,
  ADD COLUMN IF NOT EXISTS "contact_name" TEXT,
  ADD COLUMN IF NOT EXISTS "contact_phone" TEXT,
  ADD COLUMN IF NOT EXISTS "closed_by" TEXT,
  ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMP(3);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'effort_logs_contact_id_fkey') THEN
    ALTER TABLE "effort_logs"
      ADD CONSTRAINT "effort_logs_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "client_contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "attendance_records"
  ADD COLUMN IF NOT EXISTS "clock_out_place" TEXT,
  ADD COLUMN IF NOT EXISTS "clock_out_location_match" BOOLEAN,
  ADD COLUMN IF NOT EXISTS "clock_out_distance_meters" INTEGER,
  ADD COLUMN IF NOT EXISTS "clock_out_location_note" TEXT;

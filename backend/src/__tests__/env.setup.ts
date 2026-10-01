// JWT_SECRET은 guards/auth.ts에서 모듈 로드 시점에 검증된다(fail-fast) — 테스트에서도 반드시 먼저 설정.
process.env.JWT_SECRET = 'jest_only_secret_value_do_not_use_in_prod';
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://esd_test:esd_test@127.0.0.1:5432/esd_test?schema=public';

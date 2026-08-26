import { prisma } from '../prisma';

/**
 * 정책 엔진: policy_settings 테이블의 값을 조회/캐시한다.
 * 야간근무 판정, 전환비율, 경고 임계값 등 "숫자/기준 판단"은
 * 반드시 이 모듈을 통해서만 계산하고, 코드에 하드코딩하지 않는다.
 */

type PolicyCacheEntry = { value: string; valueType: string };

let cache: Map<string, PolicyCacheEntry> = new Map();
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 30_000; // 30초 캐시 — 관리자가 정책값을 바꾸면 최대 30초 내 반영

async function ensureCache() {
  const now = Date.now();
  if (now - cacheLoadedAt < CACHE_TTL_MS && cache.size > 0) return;
  const rows = await prisma.policySetting.findMany();
  const next = new Map<string, PolicyCacheEntry>();
  for (const row of rows) {
    // scopeDepartmentId가 없는 전사 기본값을 우선 저장, 있는 경우 department별 키로도 저장
    const key = row.scopeDepartmentId ? `${row.key}::${row.scopeDepartmentId}` : row.key;
    next.set(key, { value: row.value, valueType: row.valueType });
  }
  cache = next;
  cacheLoadedAt = now;
}

export function invalidatePolicyCache() {
  cacheLoadedAt = 0;
}

async function getRaw(key: string, departmentId?: string): Promise<PolicyCacheEntry | undefined> {
  await ensureCache();
  if (departmentId) {
    const scoped = cache.get(`${key}::${departmentId}`);
    if (scoped) return scoped;
  }
  return cache.get(key);
}

export async function getPolicyString(key: string, fallback = '', departmentId?: string): Promise<string> {
  const entry = await getRaw(key, departmentId);
  return entry ? entry.value : fallback;
}

export async function getPolicyNumber(key: string, fallback = 0, departmentId?: string): Promise<number> {
  const entry = await getRaw(key, departmentId);
  if (!entry) return fallback;
  const n = Number(entry.value);
  return Number.isNaN(n) ? fallback : n;
}

export async function getPolicyBoolean(key: string, fallback = false, departmentId?: string): Promise<boolean> {
  const entry = await getRaw(key, departmentId);
  if (!entry) return fallback;
  return entry.value === 'true';
}

export async function getPolicyJSON<T = unknown>(key: string, fallback: T, departmentId?: string): Promise<T> {
  const entry = await getRaw(key, departmentId);
  if (!entry) return fallback;
  try {
    return JSON.parse(entry.value) as T;
  } catch {
    return fallback;
  }
}

export async function setPolicyString(key: string, value: string, departmentId: string | null = null): Promise<void> {
  const existing = await prisma.policySetting.findFirst({ where: { key, scopeDepartmentId: departmentId } });
  if (existing) {
    await prisma.policySetting.update({ where: { id: existing.id }, data: { value, valueType: 'STRING' } });
  } else {
    await prisma.policySetting.create({ data: { key, value, valueType: 'STRING', scopeDepartmentId: departmentId } });
  }
  invalidatePolicyCache();
}

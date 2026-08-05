import { prisma } from '../../common/prisma';
import { getPolicyJSON, getPolicyString } from '../../common/policy-engine/policy-engine';
import type { DauofficeEmployee } from './dauoffice-client';

const DEPT_KEYWORDS = ['본부', '팀', '부', '실', '센터', '그룹', '사업부', '담당', '사업', '부문'];
const DEPT_TYPES = new Set(['dept', 'department', 'organization', 'org']);
const HANGUL_RE = /[가-힣]/;

/**
 * 다우오피스 userGroups에서 실제 부서명을 추출한다. (AMS _extract_department 이식)
 * 우선순위: 1) type이 dept/organization류 2) 한국어+부서 키워드 3) 한국어 포함 4) 첫 그룹명
 */
function extractDepartmentFromGroups(emp: DauofficeEmployee): string {
  const groups = emp.userGroups ?? [];

  for (const g of groups) {
    if (DEPT_TYPES.has(String(g.type ?? '').toLowerCase())) {
      const name = (g.name ?? '').trim();
      if (name) return name;
    }
  }
  for (const g of groups) {
    const name = (g.name ?? '').trim();
    if (HANGUL_RE.test(name) && DEPT_KEYWORDS.some((kw) => name.includes(kw))) return name;
  }
  for (const g of groups) {
    const name = (g.name ?? '').trim();
    if (HANGUL_RE.test(name)) return name;
  }
  if (groups.length > 0) return (groups[0].name ?? '').trim();
  return '';
}

/**
 * 부서명 판정: 관리자가 등록한 수동 보정값(DauofficeDepartmentOverride)이 있으면 우선 적용하고,
 * 없으면 다우오피스 조직도 데이터에서 추출한다.
 * (AMS의 코드에 하드코딩된 DEPT_MAP을 DB 테이블로 옮긴 것 — 정책값 분리 원칙)
 */
export async function resolveDepartmentName(emp: DauofficeEmployee): Promise<string> {
  const override = await prisma.dauofficeDepartmentOverride.findUnique({
    where: { dauofficeLoginId: emp.loginId },
  });
  if (override) return override.departmentName;
  return extractDepartmentFromGroups(emp);
}

/** userGroups/보정값/직위/사번이 전부 없으면 "부서 노드"(사람이 아닌 조직 항목)로 간주해 제외 */
export async function isLikelyDepartmentNode(emp: DauofficeEmployee): Promise<boolean> {
  const hasOverride = await prisma.dauofficeDepartmentOverride.findUnique({
    where: { dauofficeLoginId: emp.loginId },
  });
  const hasGroups = (emp.userGroups ?? []).length > 0;
  return !hasGroups && !hasOverride && !emp.positionName && !emp.employeeNumber;
}

export type ResolvedWorkType = 'HQ_FLEX' | 'HQ_FIXED' | 'RESIDENT';

interface WorkTypeRule {
  pattern: string;
  workType: ResolvedWorkType;
}

/**
 * 근무유형(탄력/고정/상주)은 다우오피스에 없는 ESD 자체 개념이므로,
 * 정책값(DEPARTMENT_WORKTYPE_RULES)의 부서명 패턴 규칙으로 자동 매핑한다.
 * 일치하는 규칙이 없으면 DEFAULT_SYNCED_WORK_TYPE 정책값을 기본값으로 사용한다.
 */
export async function resolveWorkType(departmentName: string): Promise<ResolvedWorkType> {
  const rules = await getPolicyJSON<WorkTypeRule[]>('DEPARTMENT_WORKTYPE_RULES', []);
  for (const rule of rules) {
    if (rule.pattern && departmentName.includes(rule.pattern)) {
      return rule.workType;
    }
  }
  const fallback = await getPolicyString('DEFAULT_SYNCED_WORK_TYPE', 'HQ_FIXED');
  if (fallback === 'HQ_FLEX' || fallback === 'RESIDENT') return fallback;
  return 'HQ_FIXED';
}

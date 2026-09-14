/**
 * 부서를 영업부/기술부로 분류하는 공용 기준(2026-09-14 확정) — 다우오피스 조직도 명칭에는
 * "영업부"/"기술부"라는 코드 자체가 없어서 이름 패턴으로 판별한다. "OO사업부"/"OO사업본부"처럼
 * "사업"이 붙는 부서(index.tsx의 SALES_OVERRIDE 대상 부서 — 공공사업본부/보안사업본부/
 * 솔루션사업부/DX사업부/SI사업본부 등 — 와 동일한 기준)는 영업부, 그 외 솔루션·엔지니어·
 * 기술지원·클라우드·Back-up·Cluster가 이름에 들어간 부서는 기술부로 묶는다. "사업" 규칙을
 * 먼저 적용해서 "솔루션사업부"처럼 둘 다 걸리는 경우엔 영업부가 우선한다.
 *
 * 출퇴근·근로시간 화면(부서별/영업부만/기술부만 보기)과 고객사별 공수관리 화면("엔지니어별"
 * 관점의 대상 목록 — 실제 기술부 소속만 "엔지니어"로 취급)이 이 기준을 함께 쓴다.
 */
export type DeptGroup = 'sales' | 'tech' | 'other';
const TECH_DEPT_KEYWORDS = ['솔루션', '엔지니어', '기술지원', '클라우드', 'back-up', 'cluster'];

export function classifyDeptGroup(department: string): DeptGroup {
  if (department.includes('사업')) return 'sales';
  const lower = department.toLowerCase();
  if (TECH_DEPT_KEYWORDS.some((kw) => lower.includes(kw))) return 'tech';
  return 'other';
}

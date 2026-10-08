/**
 * 2026-10-08: 자동 생성 프로젝트 코드는 "DSTI-0001" 형식이다(처음엔 AUTO- 였으나 회사 표기에 맞춰 변경).
 * 수동으로 만든 "DSTI-ABC" 같은 숫자가 아닌 코드는 번호 계산에서 무시한다(없는 번호로 오해해 충돌하지 않도록).
 */
export const PROJECT_CODE_PREFIX = 'DSTI-';
const NUMERIC_CODE = /^DSTI-(\d+)$/;

export async function nextProjectCode(db: { project: { findMany: (args: any) => Promise<{ code: string }[]> } }): Promise<string> {
  const rows = await db.project.findMany({
    where: { code: { startsWith: PROJECT_CODE_PREFIX } },
    select: { code: true },
    orderBy: { code: 'desc' },
    take: 200,
  });
  let max = 0;
  for (const r of rows) {
    const m = NUMERIC_CODE.exec(r.code);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${PROJECT_CODE_PREFIX}${String(max + 1).padStart(4, '0')}`;
}

/**
 * 2026-09-14: "드롭다운에 들어가는 값은 항상 오름차순(가나다순)으로 정렬해서 보여달라"는 요청 —
 * 투입시간처럼 값 기준으로 정렬하면 대상(고객사/엔지니어 등)이 많아질수록 원하는 이름을 찾기
 * 어려워진다는 이유. 이후 새로 만드는 드롭다운/선택 목록도 이 헬퍼로 정렬해서 이 규칙을 지킨다 —
 * localeCompare(..., 'ko')는 한글은 가나다순, 영문/숫자가 섞여 있어도 자연스러운 오름차순으로 비교한다.
 */
export function sortByLabelKo<T>(items: T[], labelOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => labelOf(a).localeCompare(labelOf(b), 'ko'));
}

import type { Response } from 'express';

/**
 * 2026-09-30 추가(Medium, M-3): 상한(take)이 걸린 목록 API가 "조용히" 잘리던 문제.
 *
 * 감사인 화면(500건), 일일업무일지(1000건), 야간·주말작업 보고서(1000건), 피드백함(300건) 등은
 * 상한을 넘으면 최신 N건만 내려주는데, 응답에 그 사실이 전혀 표시되지 않아 화면은 그게 전체인
 * 것처럼 보여줬다(특히 감사 목적 화면에서 "기록이 없다"고 오해할 수 있다).
 *
 * 해결: 상한보다 1건 더 조회해서(take: limit + 1) 넘쳤는지 판정하고, 넘쳤으면 잘라서 내려주되
 * 응답 헤더 X-Result-Truncated: true / X-Result-Limit: N 으로 알린다. 응답 본문(배열) 형태는
 * 바꾸지 않아서 기존 화면·스크립트가 그대로 동작한다(하위호환). 화면은 헤더를 보고 배너를 띄운다.
 */
export function takeWithTruncation<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  if (rows.length > limit) return { rows: rows.slice(0, limit), truncated: true };
  return { rows, truncated: false };
}

export function setTruncationHeaders(res: Response, truncated: boolean, limit: number) {
  res.setHeader('X-Result-Limit', String(limit));
  res.setHeader('X-Result-Truncated', truncated ? 'true' : 'false');
  // 브라우저 JS에서 읽을 수 있게 노출(같은 출처 nginx 프록시 구조라 필수는 아니지만, 다른 출처 CORS 대비).
  res.setHeader('Access-Control-Expose-Headers', 'X-Result-Limit, X-Result-Truncated');
}

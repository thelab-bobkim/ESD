/**
 * 시간대·요일에 따라 달라지는 인사말 — 외부 API/AI 호출 없이, 미리 준비한 문구 세트에서 그 날짜
 * 기준으로 하나를 골라 쓴다(2026-09-01 도입). 같은 날 안에서는(새로고침해도) 항상 같은 문구가
 * 나오도록 날짜를 시드로 써서 고정하고, 요일이 바뀌면 자연스럽게 다른 문구가 나온다.
 * 날씨는 아직 반영하지 않는다(외부 날씨 API 연동은 다음 단계로 미룸 — 우선 요일·시간대만).
 */

type Bucket = 'DAWN' | 'MORNING' | 'LUNCH' | 'AFTERNOON' | 'EVENING';

function currentBucket(hour: number): Bucket {
  if (hour < 6) return 'DAWN';
  if (hour < 12) return 'MORNING';
  if (hour < 14) return 'LUNCH';
  if (hour < 19) return 'AFTERNOON';
  return 'EVENING';
}

// 요일별(0=일 ~ 6=토) 아침 인사말 세트. 월~금은 그 요일 분위기를 살짝 담았고, 주말은 공통 문구를 쓴다
// (관리자/직원이 주말에 접속하는 경우가 드물지만 대비).
const MORNING_BY_WEEKDAY: Record<number, string[]> = {
  0: ['오늘도 좋은 하루 보내세요'],
  1: ['새로운 한 주가 시작됐어요, 이번 주도 화이팅이에요', '월요일이에요, 가볍게 시작해봐요', '한 주의 시작이에요, 오늘도 잘 부탁드려요'],
  2: ['오늘도 즐거운 하루 시작하세요', '화요일도 힘차게 시작해봐요', '어제보다 조금 더 수월한 하루 되세요'],
  3: ['한 주의 중간이에요, 오늘도 화이팅', '수요일이에요, 벌써 절반 왔어요', '오늘도 즐거운 하루 시작하세요'],
  4: ['목요일이에요, 조금만 더 힘내봐요', '오늘도 좋은 하루 시작하세요', '내일이면 금요일이에요, 오늘도 화이팅'],
  5: ['불금이에요! 오늘 하루도 상쾌하게 시작해봐요', '금요일이에요, 이번 주도 정말 고생 많으셨어요', '오늘만 지나면 주말이에요, 화이팅'],
  6: ['오늘도 좋은 하루 보내세요'],
};

const LUNCH_MSGS = ['점심은 맛있게 드셨나요', '든든하게 챙겨 드셨길 바라요', '오후도 힘내볼까요'];
const AFTERNOON_MSGS = ['오늘도 수고 많으세요', '오후도 힘내세요', '거의 다 왔어요, 조금만 더 힘내요'];

// 요일별 저녁/퇴근 인사말 세트 — hero 카드(온종일 노출)와 퇴근 완료 토스트가 같은 세트를 쓰되
// 시드를 살짝 다르게 줘서 서로 다른 문구가 뽑히게 한다(clockOutGreeting 참고).
const EVENING_BY_WEEKDAY: Record<number, string[]> = {
  0: ['오늘 하루도 고생하셨어요'],
  1: ['오늘 하루도 고생하셨어요', '한 주의 시작, 잘 마무리하셨어요'],
  2: ['오늘 하루도 고생하셨어요', '내일도 좋은 하루 되세요'],
  3: ['한 주의 절반, 정말 고생하셨어요', '오늘 하루도 고생하셨어요'],
  4: ['오늘 하루도 고생하셨어요', '내일이면 금요일이에요, 조금만 더 힘내요'],
  5: ['한 주 동안 정말 고생 많으셨어요, 좋은 주말 보내세요', '불금 저녁이에요, 편안한 주말 되세요'],
  6: ['오늘 하루도 고생하셨어요'],
};

const DAWN_MSGS = ['늦은 시간까지 고생 많으세요', '무리하지 말고 마무리하세요'];

function pick<T>(arr: T[], seed: number): T {
  const i = ((seed % arr.length) + arr.length) % arr.length;
  return arr[i];
}

// 그 날짜(로컬 기준) 하나를 정수로 — 하루 안에서는 항상 같은 값이 나오도록 고정하는 시드로 쓴다.
function dateSeed(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** 화면 상단 "지금 상태" 카드의 인사말(이름 뒤에 붙는 문구). 하루 중 시간대에 따라 자동으로 바뀐다. */
export function heroGreeting(): string {
  const now = new Date();
  const seed = dateSeed(now);
  const weekday = now.getDay();
  switch (currentBucket(now.getHours())) {
    case 'DAWN':
      return pick(DAWN_MSGS, seed);
    case 'MORNING':
      return pick(MORNING_BY_WEEKDAY[weekday] ?? MORNING_BY_WEEKDAY[1], seed);
    case 'LUNCH':
      return pick(LUNCH_MSGS, seed);
    case 'AFTERNOON':
      return pick(AFTERNOON_MSGS, seed);
    case 'EVENING':
      return pick(EVENING_BY_WEEKDAY[weekday] ?? EVENING_BY_WEEKDAY[1], seed);
  }
}

/** 퇴근 완료 토스트 메시지 뒤에 붙는 인사말. hero 인사말과 겹치지 않게 시드를 살짝 다르게 준다. */
export function clockOutGreeting(): string {
  const now = new Date();
  const weekday = now.getDay();
  return pick(EVENING_BY_WEEKDAY[weekday] ?? EVENING_BY_WEEKDAY[1], dateSeed(now) + 1);
}

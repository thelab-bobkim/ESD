/**
 * 시간대·요일·날씨에 따라 달라지는 인사말 — AI 호출 없이, 미리 준비한 문구 세트에서 그 날짜
 * 기준으로 하나를 골라 쓴다(2026-09-01 도입, 날씨는 2026-09-01 후반 추가). 같은 날 안에서는
 * (새로고침해도) 항상 같은 문구가 나오도록 날짜를 시드로 써서 고정하고, 요일이 바뀌면 자연스럽게
 * 다른 문구가 나온다. 날씨는 요일별 기본 문구 뒤에 짧은 문구를 덧붙이는 방식으로 반영한다(비/눈/
 * 뇌우/안개, 폭염/한파). 날씨 정보가 없으면(API 키 미설정, 조회 실패 등) 그냥 덧붙이지 않는다.
 */

export type WeatherCondition = 'CLEAR' | 'CLOUDS' | 'RAIN' | 'SNOW' | 'STORM' | 'FOG' | 'UNKNOWN';

export interface WeatherInfo {
  condition: WeatherCondition | null;
  tempC: number | null;
}

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

// 날씨 조건/기온에 따라 기본 인사말 뒤에 덧붙일 짧은 문구. 정보가 없으면 빈 문자열(덧붙이지 않음).
function weatherSuffix(weather?: WeatherInfo | null): string {
  if (!weather?.condition) return '';
  switch (weather.condition) {
    case 'RAIN':
      return ' · 비가 오니 우산 챙기세요 ☔';
    case 'SNOW':
      return ' · 눈길 조심하세요 ❄️';
    case 'STORM':
      return ' · 천둥번개가 있으니 이동 시 조심하세요 ⛈️';
    case 'FOG':
      return ' · 안개가 껴 있으니 이동 시 조심하세요 🌫️';
    default:
      if (weather.tempC != null && weather.tempC >= 33) return ' · 더위가 심하니 물 자주 드세요 🥵';
      if (weather.tempC != null && weather.tempC <= 0) return ' · 날이 많이 추우니 따뜻하게 입으세요 🥶';
      return '';
  }
}

/**
 * 화면 상단 "지금 상태" 카드의 인사말(이름 뒤에 붙는 문구). 하루 중 시간대에 따라 자동으로 바뀌고,
 * weather를 넘기면 날씨 문구가 뒤에 덧붙는다(생략 가능 — 없으면 요일/시간대 인사말만 나온다).
 */
export function heroGreeting(weather?: WeatherInfo | null): string {
  const now = new Date();
  const seed = dateSeed(now);
  const weekday = now.getDay();
  let base: string;
  switch (currentBucket(now.getHours())) {
    case 'DAWN':
      base = pick(DAWN_MSGS, seed);
      break;
    case 'MORNING':
      base = pick(MORNING_BY_WEEKDAY[weekday] ?? MORNING_BY_WEEKDAY[1], seed);
      break;
    case 'LUNCH':
      base = pick(LUNCH_MSGS, seed);
      break;
    case 'AFTERNOON':
      base = pick(AFTERNOON_MSGS, seed);
      break;
    case 'EVENING':
      base = pick(EVENING_BY_WEEKDAY[weekday] ?? EVENING_BY_WEEKDAY[1], seed);
      break;
  }
  return base + weatherSuffix(weather);
}

/** 퇴근 완료 토스트 메시지 뒤에 붙는 인사말. hero 인사말과 겹치지 않게 시드를 살짝 다르게 준다. */
export function clockOutGreeting(weather?: WeatherInfo | null): string {
  const now = new Date();
  const weekday = now.getDay();
  const base = pick(EVENING_BY_WEEKDAY[weekday] ?? EVENING_BY_WEEKDAY[1], dateSeed(now) + 1);
  return base + weatherSuffix(weather);
}

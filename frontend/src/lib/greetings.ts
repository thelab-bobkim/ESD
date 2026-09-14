/**
 * 시간대·요일·날씨에 따라 달라지는 인사말 — AI 호출 없이, 미리 준비한 문구 세트에서 그 날짜
 * 기준으로 하나를 골라 쓴다(2026-09-01 도입, 날씨는 2026-09-01 후반 추가). 같은 날 안에서는
 * (새로고침해도) 항상 같은 문구가 나오도록 날짜를 시드로 써서 고정하고, 요일이 바뀌면 자연스럽게
 * 다른 문구가 나온다. 날씨는 데이터가 있으면(맑음/흐림 포함) 항상 짧은 문구를 덧붙인다 — 비/눈/
 * 뇌우/안개나 폭염/한파처럼 특별히 챙길 게 있을 땐 그 내용을, 평범한 날씨엔 기온과 함께 가벼운
 * 문구를 붙여서 "날씨가 연동되고 있다"는 게 항상 눈에 보이게 한다. 날씨 정보 자체가 없으면
 * (API 키 미설정/미활성화, 조회 실패 등) condition이 null로 오고, 그때만 아무것도 안 붙인다.
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

// 요일별(0=일 ~ 6=토) 문구 세트들. 월~금은 그 요일 분위기를 살짝 담았고, 주말은 공통 문구를 쓴다
// (관리자/직원이 주말에 접속하는 경우가 드물지만 대비). 시간대별로 다 따로 두어서, 하루 종일 앱을
// 들여다봐도 아침/점심/오후/저녁이 서로 다르게 느껴지도록 했다.

// 토요일(6)/일요일(0)은 근무일이 아니므로 "화이팅/힘내세요" 류가 아니라, 휴일을 편하게 보내라는
// 멘트를 여러 개 준비해두고 그중 하나를 뽑아 보여준다(2026-09-14, 여러 스크립트 요청사항).
const WEEKEND_MORNING_MSGS = [
  '주말 아침이에요, 가족과 함께 여유로운 하루 보내세요',
  '오늘은 쉬는 날이에요, 푹 쉬시면서 재충전하세요',
  '즐거운 주말 보내세요, 소중한 사람들과 좋은 시간 되시길 바라요',
  '주말엔 잠깐 일 생각은 내려놓고 편히 쉬세요',
  '화창한 주말 아침이에요, 가족과 함께 즐거운 시간 보내세요',
];
const WEEKEND_LUNCH_MSGS = [
  '주말 점심 맛있게 드세요, 가족과 함께 좋은 시간 되세요',
  '오늘 점심은 여유롭게 드시면서 푹 쉬세요',
  '든든하게 드시고 남은 주말도 편하게 보내세요',
];
const WEEKEND_AFTERNOON_MSGS = [
  '주말 오후, 가족과 함께 즐거운 시간 보내세요',
  '오늘은 편하게 쉬시면서 좋은 오후 되세요',
  '소중한 사람들과 함께하는 여유로운 오후 되세요',
];
const WEEKEND_EVENING_MSGS = [
  '오늘 하루도 가족과 함께 즐거운 연휴 보내셨길 바라요',
  '편안한 주말 저녁 되세요, 내일 뵙겠습니다',
  '오늘도 푹 쉬시고 좋은 주말 저녁 되세요',
];

const MORNING_BY_WEEKDAY: Record<number, string[]> = {
  0: WEEKEND_MORNING_MSGS,
  1: ['새로운 한 주가 시작됐어요, 이번 주도 화이팅이에요', '월요일이에요, 가볍게 시작해봐요', '한 주의 시작이에요, 오늘도 잘 부탁드려요'],
  2: ['오늘도 즐거운 하루 시작하세요', '화요일도 힘차게 시작해봐요', '어제보다 조금 더 수월한 하루 되세요'],
  3: ['한 주의 중간이에요, 오늘도 화이팅', '수요일이에요, 벌써 절반 왔어요', '오늘도 즐거운 하루 시작하세요'],
  4: ['목요일이에요, 조금만 더 힘내봐요', '오늘도 좋은 하루 시작하세요', '내일이면 금요일이에요, 오늘도 화이팅'],
  5: ['불금이에요! 오늘 하루도 상쾌하게 시작해봐요', '금요일이에요, 이번 주도 정말 고생 많으셨어요', '오늘만 지나면 주말이에요, 화이팅'],
  6: WEEKEND_MORNING_MSGS,
};

const LUNCH_BY_WEEKDAY: Record<number, string[]> = {
  0: WEEKEND_LUNCH_MSGS,
  1: ['점심 맛있게 드셨나요, 남은 오후도 화이팅', '월요일 점심이에요, 잠깐 숨 돌리세요'],
  2: ['점심은 맛있게 드셨나요', '든든하게 드셨길 바라요, 오후도 힘내봐요'],
  3: ['한 주의 중간, 점심 맛있게 드세요', '벌써 절반 왔어요, 점심 든든히 드세요'],
  4: ['점심 맛있게 드셨나요, 내일이면 금요일이에요', '오후도 조금만 더 힘내봐요'],
  5: ['불금 점심이에요, 맛있게 드세요', '점심 드시고 나면 곧 주말이에요'],
  6: WEEKEND_LUNCH_MSGS,
};

const AFTERNOON_BY_WEEKDAY: Record<number, string[]> = {
  0: WEEKEND_AFTERNOON_MSGS,
  1: ['월요일 오후도 힘내세요', '오늘도 수고 많으세요'],
  2: ['화요일 오후, 조금만 더 힘내요', '오후도 화이팅이에요'],
  3: ['한 주 절반 넘었어요, 오후도 힘내세요', '거의 다 왔어요, 조금만 더 힘내요'],
  4: ['목요일 오후예요, 내일이면 금요일이에요', '오늘도 수고 많으세요'],
  5: ['불금 오후예요, 이제 곧 주말이에요', '오늘만 지나면 주말, 조금만 더 힘내요'],
  6: WEEKEND_AFTERNOON_MSGS,
};

// 요일별 저녁/퇴근 인사말 세트 — hero 카드(온종일 노출)와 퇴근 완료 토스트가 같은 세트를 쓰되
// 시드를 살짝 다르게 줘서 서로 다른 문구가 뽑히게 한다(clockOutGreeting 참고).
const EVENING_BY_WEEKDAY: Record<number, string[]> = {
  0: WEEKEND_EVENING_MSGS,
  1: ['오늘 하루도 고생하셨어요', '한 주의 시작, 잘 마무리하셨어요'],
  2: ['오늘 하루도 고생하셨어요', '내일도 좋은 하루 되세요'],
  3: ['한 주의 절반, 정말 고생하셨어요', '오늘 하루도 고생하셨어요'],
  4: ['오늘 하루도 고생하셨어요', '내일이면 금요일이에요, 조금만 더 힘내요'],
  5: ['한 주 동안 정말 고생 많으셨어요, 좋은 주말 보내세요', '불금 저녁이에요, 편안한 주말 되세요'],
  6: WEEKEND_EVENING_MSGS,
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

// 날씨 조건/기온에 따라 기본 인사말 뒤에 덧붙일 짧은 문구. 데이터가 있으면(맑음/흐림 포함) 항상
// 뭔가를 붙인다 — 그래야 "날씨가 실제로 연동되고 있다"는 게 매번 눈으로 확인된다. condition
// 자체가 null이면(키 미설정/미활성화/조회 실패) 아무것도 안 붙인다.
function weatherSuffix(weather?: WeatherInfo | null): string {
  if (!weather?.condition) return '';
  const t = weather.tempC;
  const tempTag = t != null ? ` (${t}°C)` : '';
  switch (weather.condition) {
    case 'RAIN':
      return ` · 비가 오니 우산 챙기세요 ☔${tempTag}`;
    case 'SNOW':
      return ` · 눈길 조심하세요 ❄️${tempTag}`;
    case 'STORM':
      return ` · 천둥번개가 있으니 이동 시 조심하세요 ⛈️${tempTag}`;
    case 'FOG':
      return ` · 안개가 껴 있으니 이동 시 조심하세요 🌫️${tempTag}`;
    case 'CLEAR':
      if (t != null && t >= 33) return ` · 맑지만 더위가 심해요, 물 자주 드세요 🥵${tempTag}`;
      if (t != null && t <= 0) return ` · 맑지만 많이 추워요, 따뜻하게 입으세요 🥶${tempTag}`;
      return ` · 맑은 하늘이에요 ☀️${tempTag}`;
    case 'CLOUDS':
      if (t != null && t >= 33) return ` · 흐리지만 더위가 심해요, 물 자주 드세요 🥵${tempTag}`;
      if (t != null && t <= 0) return ` · 흐리고 많이 추워요, 따뜻하게 입으세요 🥶${tempTag}`;
      return ` · 구름 낀 하늘이에요 ⛅${tempTag}`;
    default:
      // 분류 못 한 그 외 날씨(UNKNOWN) — 조건 문구 없이 기온만 있으면 기온만 붙인다.
      return t != null ? ` · 현재 기온 ${t}°C` : '';
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
      base = pick(LUNCH_BY_WEEKDAY[weekday] ?? LUNCH_BY_WEEKDAY[1], seed);
      break;
    case 'AFTERNOON':
      base = pick(AFTERNOON_BY_WEEKDAY[weekday] ?? AFTERNOON_BY_WEEKDAY[1], seed);
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

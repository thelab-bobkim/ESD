import https from 'https';
import { getPolicyString } from './policy-engine/policy-engine';

/**
 * OpenWeatherMap 현재 날씨 조회(본사 위경도 기준) — 인사말 문구에 반영하기 위한 용도일 뿐이라
 * 정확도가 핵심은 아니다. 호출량을 아끼기 위해 30분간 메모리에 캐시한다(여러 직원이 동시에
 * 접속해도 실제 외부 호출은 드물게만 나가게). API 키가 아직 설정 안 되어 있으면(.env.prod에
 * OPENWEATHER_API_KEY 미설정) 조용히 null을 반환한다 — 날씨 없이도 인사말/앱 자체는 정상 동작해야
 * 하므로, 이 조회가 실패한다고 다른 기능까지 막으면 안 된다.
 */

export type WeatherCondition = 'CLEAR' | 'CLOUDS' | 'RAIN' | 'SNOW' | 'STORM' | 'FOG' | 'UNKNOWN';

export interface WeatherSnapshot {
  condition: WeatherCondition;
  tempC: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30분
let cache: { snapshot: WeatherSnapshot | null; fetchedAt: number } | null = null;

// OpenWeatherMap의 weather[0].main 값을 앱에서 쓰는 단순 분류로 축약한다.
function mapCondition(main: string | undefined): WeatherCondition {
  switch (main) {
    case 'Clear':
      return 'CLEAR';
    case 'Clouds':
      return 'CLOUDS';
    case 'Rain':
    case 'Drizzle':
      return 'RAIN';
    case 'Snow':
      return 'SNOW';
    case 'Thunderstorm':
      return 'STORM';
    case 'Mist':
    case 'Fog':
    case 'Haze':
    case 'Dust':
    case 'Smoke':
      return 'FOG';
    default:
      return 'UNKNOWN';
  }
}

function requestJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

export async function getCurrentWeather(): Promise<WeatherSnapshot | null> {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return null;

  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  try {
    const hqLat = await getPolicyString('HQ_LATITUDE', '');
    const hqLng = await getPolicyString('HQ_LONGITUDE', '');
    if (!hqLat || !hqLng) {
      cache = { snapshot: null, fetchedAt: Date.now() };
      return null;
    }
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${encodeURIComponent(hqLat)}&lon=${encodeURIComponent(hqLng)}&appid=${apiKey}&units=metric&lang=kr`;
    const json = await requestJson(url);
    if (json?.cod !== 200 || !json?.weather?.[0]) {
      cache = { snapshot: null, fetchedAt: Date.now() };
      return null;
    }
    const snapshot: WeatherSnapshot = {
      condition: mapCondition(json.weather[0].main),
      tempC: Math.round(json.main?.temp ?? 0),
    };
    cache = { snapshot, fetchedAt: Date.now() };
    return snapshot;
  } catch {
    // 날씨 조회 실패(네트워크 오류, 키 오류 등)는 조용히 무시한다 — 인사말이 날씨 없이 나오는 게
    // 앱 전체가 에러를 뿜는 것보다 훨씬 낫다.
    cache = { snapshot: null, fetchedAt: Date.now() };
    return null;
  }
}

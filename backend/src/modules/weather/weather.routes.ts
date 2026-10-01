import { createRouter } from '../../common/async-router';
import { requireAuth } from '../../common/guards/auth';
import { getCurrentWeather } from '../../common/weather';

export const weatherRouter = createRouter();
weatherRouter.use(requireAuth);

/**
 * 본사 위치 기준 현재 날씨(조건+기온) — 출퇴근 인사말에 반영하기 위한 용도. API 키 미설정이거나
 * 조회 실패 시 condition:null로 응답한다(프론트는 이 경우 날씨 없이 인사말을 그대로 보여준다).
 */
weatherRouter.get('/current', async (_req, res) => {
  const snapshot = await getCurrentWeather();
  return res.json({
    success: true,
    data: snapshot ?? { condition: null, tempC: null },
  });
});

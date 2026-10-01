import { dauofficeSchedulersEnabled } from '../common/feature-flags';

describe('[A안] 다우오피스 스케줄러 배제 플래그', () => {
  it('환경변수가 없으면 꺼짐(기본 배제)', () => {
    expect(dauofficeSchedulersEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
  it('명시적으로 true일 때만 켜진다', () => {
    expect(dauofficeSchedulersEnabled({ DAUOFFICE_SCHEDULERS_ENABLED: 'true' } as NodeJS.ProcessEnv)).toBe(true);
  });
  it('오타/대문자/공백은 켜지지 않는다(실수로 켜지는 일 방지)', () => {
    for (const v of ['TRUE', 'True', '1', 'yes', ' true', 'true ']) {
      expect(dauofficeSchedulersEnabled({ DAUOFFICE_SCHEDULERS_ENABLED: v } as NodeJS.ProcessEnv)).toBe(false);
    }
  });
  it('기본값(false)으로 두면 실제 부팅 경로에서 스케줄러가 시작되지 않는다', () => {
    // server.ts는 dauofficeSchedulersEnabled()가 false면 start*Scheduler()를 호출하지 않는다.
    // 여기서는 그 판단의 근거가 되는 값만 확인한다(부팅 자체는 스모크 테스트로 별도 확인).
    const prev = process.env.DAUOFFICE_SCHEDULERS_ENABLED;
    delete process.env.DAUOFFICE_SCHEDULERS_ENABLED;
    expect(dauofficeSchedulersEnabled()).toBe(false);
    if (prev !== undefined) process.env.DAUOFFICE_SCHEDULERS_ENABLED = prev;
  });
});

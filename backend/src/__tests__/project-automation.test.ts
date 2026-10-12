import { pickClientDefaults, groupUnlinked, pickTopEngineers } from '../modules/projects/project-automation-plan';

describe('pickClientDefaults (지난번에 쓴 값)', () => {
  it('고객사별로 가장 최근의 작업유형/프로젝트를 고른다', () => {
    const r = pickClientDefaults([
      { clientName: '코스콤', workType: '정기점검', projectId: 'p1', sourceStatus: 'CLIENT_WORK', description: 'a' },
      { clientName: '(주)코스콤', workType: '장애대응', projectId: 'p1', sourceStatus: 'CLIENT_WORK', description: 'b' },
    ]);
    expect(r).toEqual([{ clientName: '코스콤', workType: '정기점검', projectId: 'p1' }]);
  });
  it('작업내용 없는 기본값 "기타"는 직원이 고른 값이 아니므로 건너뛰고 그 다음 값을 쓴다', () => {
    const r = pickClientDefaults([
      { clientName: '코스콤', workType: '기타', projectId: null, sourceStatus: 'REMOTE', description: '' },
      { clientName: '코스콤', workType: '신규설치', projectId: null, sourceStatus: 'REMOTE', description: 'x' },
    ]);
    expect(r[0].workType).toBe('신규설치');
  });
  it('작업내용이 있는 "기타"는 실제 선택으로 인정한다', () => {
    const r = pickClientDefaults([{ clientName: '코스콤', workType: '기타', projectId: null, sourceStatus: 'CLIENT_WORK', description: '특이 작업' }]);
    expect(r[0].workType).toBe('기타');
  });
  it('고객사미팅(미팅목적 목록) 기록의 값은 작업유형 기본값으로 쓰지 않지만 프로젝트는 쓴다', () => {
    const r = pickClientDefaults([{ clientName: '코스콤', workType: '제안', projectId: 'p9', sourceStatus: 'CLIENT_MEETING', description: 'm' }]);
    expect(r).toEqual([{ clientName: '코스콤', workType: null, projectId: 'p9' }]);
  });
  it('내부업무/빈 고객사는 제외하고, 쓸 값이 없는 고객사는 결과에서 뺀다', () => {
    const r = pickClientDefaults([
      { clientName: '본사', workType: '교육', projectId: null, sourceStatus: 'HQ_WORKING', description: 'x' },
      { clientName: '', workType: '교육', projectId: null, sourceStatus: 'HQ_WORKING', description: 'x' },
      { clientName: '코스콤', workType: null, projectId: null, sourceStatus: 'CLIENT_WORK', description: '' },
    ]);
    expect(r).toEqual([]);
  });
});

describe('groupUnlinked (연결 안 된 공수 모아보기)', () => {
  const clients = [{ id: 'c1', name: '코스콤' }, { id: 'c2', name: '농협은행' }, { id: 'c3', name: '지점' }, { id: 'c4', name: '지점' }];
  const projects = [
    { id: 'p-done', code: 'DSTI-0002', name: '코스콤(완료)', clientId: 'c1', status: 'COMPLETED' },
    { id: 'p-act', code: 'DSTI-0001', name: '코스콤', clientId: 'c1', status: 'ACTIVE' },
  ];
  it('표기가 다른 같은 고객사를 묶고, 등록 고객사의 진행 중 프로젝트를 제안한다', () => {
    const g = groupUnlinked([
      { clientName: '코스콤', logCount: 2, minutes: 120, lastDate: '2026-10-01' },
      { clientName: '(주)코스콤', logCount: 1, minutes: 60, lastDate: '2026-10-05' },
    ], clients, projects);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ logCount: 3, minutes: 180, lastDate: '2026-10-05', registeredClient: { id: 'c1' }, suggestedProject: { id: 'p-act' } });
    expect(g[0].names.sort()).toEqual(['(주)코스콤', '코스콤']);
  });
  it('등록되지 않은 이름은 고객사/제안 없이 남긴다(관리자가 직접 고른다)', () => {
    const g = groupUnlinked([{ clientName: '이상한이름', logCount: 1, minutes: 30, lastDate: null }], clients, projects);
    expect(g[0].registeredClient).toBeNull();
    expect(g[0].suggestedProject).toBeNull();
  });
  it('같은 이름의 고객사가 둘 이상이면 특정하지 않는다', () => {
    const g = groupUnlinked([{ clientName: '지점', logCount: 1, minutes: 30, lastDate: null }], clients, projects);
    expect(g[0].registeredClient).toBeNull();
  });
  it('내부업무(본사/SAMPLE/빈 값)는 목록에서 뺀다', () => {
    const g = groupUnlinked([
      { clientName: '본사', logCount: 5, minutes: 300, lastDate: null },
      { clientName: 'SAMPLE_고객사', logCount: 1, minutes: 30, lastDate: null },
      { clientName: '', logCount: 1, minutes: 30, lastDate: null },
    ], clients, projects);
    expect(g).toEqual([]);
  });
  it('최근 작업일이 새로운 순으로 정렬한다', () => {
    const g = groupUnlinked([
      { clientName: '농협은행', logCount: 1, minutes: 30, lastDate: '2026-09-01' },
      { clientName: '코스콤', logCount: 1, minutes: 30, lastDate: '2026-10-01' },
    ], clients, projects);
    expect(g.map((x) => x.key)).toEqual(['코스콤', '농협은행']);
  });
});

describe('pickTopEngineers (PM 후보)', () => {
  const row = (projectId: string, userId: string, minutes: number, logCount: number, lastDate: string | null) => ({ projectId, userId, minutes, logCount, lastDate });
  it('프로젝트별로 공수가 가장 많은 엔지니어', () => {
    const m = pickTopEngineers([row('p1', 'a', 100, 3, '2026-10-01'), row('p1', 'b', 300, 1, '2026-09-01'), row('p2', 'a', 50, 1, null)]);
    expect(m.get('p1')?.userId).toBe('b');
    expect(m.get('p2')?.userId).toBe('a');
  });
  it('공수가 같으면 기록 수, 그다음 최근 작업일이 앞선 사람', () => {
    expect(pickTopEngineers([row('p', 'a', 100, 2, '2026-10-01'), row('p', 'b', 100, 3, '2026-01-01')]).get('p')?.userId).toBe('b');
    expect(pickTopEngineers([row('p', 'a', 100, 2, '2026-10-01'), row('p', 'b', 100, 2, '2026-10-05')]).get('p')?.userId).toBe('b');
  });
});

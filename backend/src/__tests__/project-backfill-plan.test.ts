import {
  buildBackfillPlan,
  applyMergesAndExcludes,
  normalizeName,
  type EffortRow,
} from '../modules/projects/project-backfill-plan';

// DB가 필요 없는 순수 계산 테스트 — 공수 데이터로 프로젝트를 만드는 규칙(2026-10-08 사용자 결정)을 검증한다.
const TODAY = '2026-10-08';
let seq = 0;
function row(over: Partial<EffortRow> & { date?: string }): EffortRow {
  seq++;
  return {
    id: `log-${seq}`,
    userId: over.userId ?? 'u1',
    workDate: new Date(`${over.date ?? '2026-10-01'}T00:00:00.000Z`),
    clientName: over.clientName ?? '코스콤',
    projectName: over.projectName ?? '',
    workType: over.workType ?? '정기점검',
    minutes: over.minutes ?? 60,
    sourceStatus: over.sourceStatus ?? 'CLIENT_WORK',
  };
}
const users = [{ id: 'u1', name: '김유범' }, { id: 'u2', name: '박준영' }, { id: 'sample', name: 'SAMPLE_시스템관리자' }];
function plan(rows: EffortRow[], extra: Partial<Parameters<typeof buildBackfillPlan>[0]> = {}) {
  return buildBackfillPlan({
    rows, clients: [], existingProjects: [], users, sampleUserIds: new Set(['sample']), today: TODAY, ...extra,
  });
}

describe('normalizeName', () => {
  it('공백/대소문자/(주)/괄호/기호 표기 차이를 같은 키로 합친다', () => {
    expect(normalizeName('(주)코스콤')).toBe('코스콤');
    expect(normalizeName(' 코스콤 ')).toBe('코스콤');
    expect(normalizeName('NH농협은행 (의왕)')).toBe(normalizeName('nh농협은행 의왕'));
    expect(normalizeName('')).toBe('');
    expect(normalizeName(null)).toBe('');
  });
});

describe('buildBackfillPlan — 묶는 단위/제외 규칙', () => {
  it('표기만 다른 같은 고객사는 프로젝트 1개로 합친다', () => {
    const p = plan([row({ clientName: '코스콤' }), row({ clientName: ' (주)코스콤 ' }), row({ clientName: '코스콤' })]);
    expect(p.projects).toHaveLength(1);
    expect(p.projects[0].logCount).toBe(3);
    expect(p.projects[0].name).toBe('코스콤'); // 가장 많이 쓰인 표기
  });

  it('고객사 미입력/내부업무 표기/SAMPLE 계정/비고객사 업무유형은 계획에서 제외한다', () => {
    const p = plan([
      row({ clientName: '' }),
      row({ clientName: '본사' }),
      row({ clientName: 'DSTi본사' }),
      row({ clientName: '신한이노플렉스 2차 (dsti본사)' }),
      row({ clientName: '코스콤', userId: 'sample' }),
      row({ clientName: '코스콤', workType: '식사' }),
      row({ clientName: '코스콤', workType: '셀프스터디' }),
    ]);
    expect(p.projects).toHaveLength(0);
    expect(p.skipped.emptyClient).toBe(1);
    expect(p.skipped.internalClient).toBe(3);
    expect(p.skipped.sampleUser).toBe(1);
    expect(p.skipped.excludedWorkType).toBe(2);
  });
});

describe('buildBackfillPlan — 의미 있는 고객사만', () => {
  it('공수 1건·1시간·작업명 없음 → 연결하지 않고 둔다', () => {
    const p = plan([row({ clientName: '일회성고객', minutes: 60 })]);
    expect(p.projects[0].include).toBe(false);
    expect(p.skipped.notMeaningfulClients).toBe(1);
  });
  it('공수 2건이면 포함', () => {
    expect(plan([row({ clientName: 'A사' }), row({ clientName: 'A사' })]).projects[0].include).toBe(true);
  });
  it('누적 8시간이면 1건이라도 포함, 7시간 59분은 제외', () => {
    expect(plan([row({ clientName: 'B사', minutes: 480 })]).projects[0].include).toBe(true);
    expect(plan([row({ clientName: 'B사', minutes: 479 })]).projects[0].include).toBe(false);
  });
  it('구체 작업명이 있으면 1건이라도 포함하고 Task로 만든다', () => {
    const p = plan([row({ clientName: 'C사', projectName: 'HDD Fault 교체', minutes: 30 })]);
    expect(p.projects[0].include).toBe(true);
    expect(p.projects[0].tasks.map((t) => t.title)).toEqual(['HDD Fault 교체']);
  });
  it('작업명이 고객사명과 같거나 "-"/기타 같은 일반값이면 Task로 만들지 않는다', () => {
    const p = plan([
      row({ clientName: 'D사', projectName: 'D사' }),
      row({ clientName: 'D사', projectName: '-' }),
      row({ clientName: 'D사', projectName: '기타' }),
    ]);
    expect(p.projects[0].tasks).toHaveLength(0);
  });
});

describe('buildBackfillPlan — 상태 기준(30일)', () => {
  it('마지막 공수가 30일 이내면 진행, 31일 전이면 완료', () => {
    const active = plan([row({ clientName: 'E사', date: '2026-09-08' }), row({ clientName: 'E사', date: '2026-09-01' })]);
    expect(active.projects[0].status).toBe('ACTIVE'); // 2026-09-08 → 오늘(10-08)까지 정확히 30일
    const done = plan([row({ clientName: 'F사', date: '2026-09-07' }), row({ clientName: 'F사', date: '2026-09-01' })]);
    expect(done.projects[0].status).toBe('COMPLETED'); // 31일
    expect(done.projects[0].firstDate).toBe('2026-09-01');
    expect(done.projects[0].lastDate).toBe('2026-09-07');
  });
  it('Task도 같은 기준: 최근 작업은 진행, 오래된 작업은 완료', () => {
    const p = plan([
      row({ clientName: 'G사', projectName: '최근작업', date: '2026-10-05' }),
      row({ clientName: 'G사', projectName: '옛작업', date: '2026-06-01' }),
    ]);
    const byTitle = Object.fromEntries(p.projects[0].tasks.map((t) => [t.title, t.status]));
    expect(byTitle).toEqual({ 최근작업: 'IN_PROGRESS', 옛작업: 'DONE' });
  });
});

describe('buildBackfillPlan — 엔지니어/등록 고객사/기존 프로젝트', () => {
  it('참여 엔지니어와 Task 담당자는 실제로 작업한 사람(최다)', () => {
    const p = plan([
      row({ clientName: 'H사', projectName: '서버 증설', userId: 'u1' }),
      row({ clientName: 'H사', projectName: '서버 증설', userId: 'u2' }),
      row({ clientName: 'H사', projectName: '서버 증설', userId: 'u2' }),
    ]);
    expect(p.projects[0].engineers.map((e) => e.userId)).toEqual(['u2', 'u1']);
    expect(p.projects[0].tasks[0].assigneeId).toBe('u2');
  });

  it('등록된 고객사와 이름(정규화)이 같으면 clientId를 연결하고 등록명을 프로젝트명으로 쓴다', () => {
    const p = plan([row({ clientName: ' 코스콤 ' }), row({ clientName: '코스콤' })], { clients: [{ id: 'c-kos', name: '(주)코스콤' }] });
    expect(p.projects[0].clientId).toBe('c-kos');
    expect(p.projects[0].name).toBe('(주)코스콤');
  });

  it('이미 같은 고객사 프로젝트가 있으면 재사용하고, 소규모여도 연결 대상에 포함한다(재실행 시 중복 생성 방지)', () => {
    const p = plan([row({ clientName: '코스콤', minutes: 10 })], {
      clients: [{ id: 'c-kos', name: '코스콤' }],
      existingProjects: [{ id: 'p1', code: 'DSTI-0001', name: '코스콤', clientId: 'c-kos', status: 'ACTIVE' }],
    });
    expect(p.projects[0].existing).toEqual({ id: 'p1', code: 'DSTI-0001' });
    expect(p.projects[0].include).toBe(true);
  });

  it('취소된 프로젝트는 재사용하지 않는다', () => {
    const p = plan([row({ clientName: '코스콤' }), row({ clientName: '코스콤' })], {
      clients: [{ id: 'c-kos', name: '코스콤' }],
      existingProjects: [{ id: 'p1', code: 'X', name: '코스콤', clientId: 'c-kos', status: 'CANCELLED' }],
    });
    expect(p.projects[0].existing).toBeNull();
  });
});

describe('비슷한 이름 후보와 합치기', () => {
  const rows = [
    row({ clientName: '김앤장', projectName: '' }), row({ clientName: '김앤장' }),
    row({ clientName: '김앤장법률사무소', projectName: '' }), row({ clientName: '김앤장법률사무소' }), row({ clientName: '김앤장법률사무소' }),
    row({ clientName: '무관한고객' }), row({ clientName: '무관한고객' }),
  ];

  it('자동으로 합치지 않고 후보로만 제시한다', () => {
    const p = plan(rows);
    expect(p.projects).toHaveLength(3);
    const pair = p.similarPairs.find((x) => [x.aName, x.bName].includes('김앤장') && [x.aName, x.bName].includes('김앤장법률사무소'));
    expect(pair).toBeDefined();
    expect(pair!.reason).toBe('CONTAINS');
    expect(p.similarPairs.some((x) => x.aName === '무관한고객' || x.bName === '무관한고객')).toBe(false);
  });

  it('서로 다른 등록 고객사(지점)에 각각 매칭된 경우는 합치기 후보에서 뺀다', () => {
    const p = plan(rows, { clients: [{ id: 'a', name: '김앤장' }, { id: 'b', name: '김앤장법률사무소' }] });
    expect(p.similarPairs).toHaveLength(0);
  });

  it('승인한 쌍만 합쳐지고 공수/Task/엔지니어가 합산된다', () => {
    const p = plan([
      ...rows,
      row({ clientName: '김앤장', projectName: '백업 점검', userId: 'u2' }),
    ]);
    const merged = applyMergesAndExcludes(p, [['김앤장', '김앤장법률사무소']], [], TODAY);
    expect(merged).toHaveLength(2);
    const k = merged.find((x) => x.name === '김앤장법률사무소')!;
    expect(k.logCount).toBe(6);
    expect(k.tasks.map((t) => t.title)).toEqual(['백업 점검']);
    expect(k.engineers.map((e) => e.userId).sort()).toEqual(['u1', 'u2']);
    expect(new Set(k.logIds).size).toBe(k.logIds.length); // 공수 id 중복 없음
  });

  it('제외한 키는 include=false가 된다', () => {
    const p = plan(rows);
    const out = applyMergesAndExcludes(p, [], ['무관한고객'], TODAY);
    expect(out.find((x) => x.name === '무관한고객')!.include).toBe(false);
  });
});

describe('이름 포함 관계 자동 합치기(2026-10-08)', () => {
  it('포함 관계 쌍 전체를 containsPairs로 돌려주고, 합치면 하나의 프로젝트가 된다', () => {
    const p = plan([
      row({ clientName: '코스콤' }), row({ clientName: '코스콤' }),
      row({ clientName: '안양 IT단지 코스콤안양연구센터' }), row({ clientName: '안양 IT단지 코스콤안양연구센터' }),
      row({ clientName: '코스콤 전자인증' }),
    ]);
    expect(p.containsPairs.length).toBeGreaterThanOrEqual(2);
    const merged = applyMergesAndExcludes(p, p.containsPairs, [], TODAY);
    expect(merged).toHaveLength(1);
    expect(merged[0].logCount).toBe(5);
    expect(new Set(merged[0].logIds).size).toBe(5);
  });

  it('포함되는 쪽이 "데이터센터" 같은 일반 단어뿐이면 서로 다른 고객사로 보고 합치지 않는다', () => {
    const p = plan([
      row({ clientName: '데이터센터' }), row({ clientName: '데이터센터' }),
      row({ clientName: '신한금융그룹 데이터센터' }), row({ clientName: '신한금융그룹 데이터센터' }),
      row({ clientName: 'NH농협 데이터센터' }), row({ clientName: 'NH농협 데이터센터' }),
    ]);
    expect(p.containsPairs).toHaveLength(0);
    expect(applyMergesAndExcludes(p, p.containsPairs, [], TODAY)).toHaveLength(3);
  });

  it('3글자 미만으로 겹치는 이름은 후보로도 만들지 않는다', () => {
    const p = plan([row({ clientName: '국민은행' }), row({ clientName: '국민은행' }), row({ clientName: '국민대' }), row({ clientName: '국민대' })]);
    expect(p.containsPairs).toHaveLength(0);
  });

  it('일부 이름만 공유하는(포함 관계가 아닌) 서로 다른 고객사는 합치지 않는다', () => {
    const p = plan([
      row({ clientName: '김앤장법률사무소' }), row({ clientName: '김앤장법률사무소' }),
      row({ clientName: '광장법률사무소' }), row({ clientName: '광장법률사무소' }),
    ]);
    expect(p.containsPairs).toHaveLength(0);
  });

  it('후보가 200쌍을 넘어도 containsPairs는 잘리지 않는다', () => {
    const rows: EffortRow[] = [];
    for (let i = 0; i < 30; i++) {
      rows.push(row({ clientName: '코스콤' }), row({ clientName: '코스콤' }));
      rows.push(row({ clientName: `코스콤지점${String.fromCharCode(0xac00 + i)}` }), row({ clientName: `코스콤지점${String.fromCharCode(0xac00 + i)}` }));
    }
    const p = plan(rows);
    expect(p.containsPairs.length).toBeGreaterThanOrEqual(30);
  });
});

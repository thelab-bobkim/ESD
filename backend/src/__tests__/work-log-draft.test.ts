// 업무일지 자동초안(표준 형식 · 제안 칩)을 DB 없이 검증한다.
import { formatWorkContent, buildSuggestions, durationLabel, isIncidentWork, type DraftEffort, type DraftOpenTask } from '../modules/daily-work-log/work-log-draft';
import { isMeaningfulPlan } from '../modules/daily-work-log/work-log-rules';

// KST 09:30 = UTC 00:30
const at = (kstHour: number, kstMin = 0) => new Date(Date.UTC(2026, 9, 15, kstHour - 9, kstMin));

function eff(over: Partial<DraftEffort> = {}): DraftEffort {
  return {
    clientName: '코스콤', projectName: '정기점검', workType: '정기점검', startTime: at(9, 30), endTime: at(12, 10),
    minutes: 160, actualMinutes: 160, description: '서버 로그 정리', contactName: '김담당', taskId: null, ...over,
  };
}
function task(over: Partial<DraftOpenTask> = {}): DraftOpenTask {
  return { id: 't1', title: '방화벽 룰 정리', status: 'IN_PROGRESS', dueDate: null, projectName: '코스콤 보안강화', ...over };
}

describe('formatWorkContent', () => {
  it('고객사별로 묶어 시간·소요·작업유형·담당·설명을 표준 형식으로 만든다', () => {
    const r = formatWorkContent([eff(), eff({ startTime: at(13, 30), endTime: at(15), minutes: 90, actualMinutes: 90, description: '디스크 증설' })], []);
    expect(r.text).toBe(
      ['■ 코스콤 · 정기점검', '- 09:30~12:10 (2시간 40분) · 정기점검 · 담당 김담당', '  → 서버 로그 정리',
        '- 13:30~15:00 (1시간 30분) · 정기점검 · 담당 김담당', '  → 디스크 증설'].join('\n')
    );
    expect(r.missingDescriptionCount).toBe(0);
  });

  it('설명이 비면 자리표시 문구 없이 건수만 센다', () => {
    const r = formatWorkContent([eff({ description: null }), eff({ description: '  ', startTime: at(14) })], []);
    expect(r.missingDescriptionCount).toBe(2);
    expect(r.text).not.toContain('→');
    expect(r.text).not.toContain('작업 내용을 적어');
  });

  it('진행중 작업은 "~진행중"으로 쓰고 소요시간을 붙이지 않는다', () => {
    const r = formatWorkContent([eff({ endTime: null, minutes: null, actualMinutes: null })], []);
    expect(r.text).toContain('- 09:30~진행중 · 정기점검');
    expect(r.text).not.toContain('(0분)');
  });

  it('시간순으로 정렬하고 서로 다른 고객사는 따로 묶는다', () => {
    const r = formatWorkContent([eff({ clientName: '메타온넷', projectName: null, startTime: at(14) , endTime: at(16), minutes: 120, actualMinutes: 120 }), eff()], []);
    const lines = r.text!.split('\n').filter((l) => l.startsWith('■'));
    expect(lines).toEqual(['■ 코스콤 · 정기점검', '■ 메타온넷']);
  });

  it('야간·주말 메일보고를 덧붙인다', () => {
    const r = formatWorkContent([], [{ kind: 'NIGHT', clientNameRaw: '농협', workContent: '야간 패치 적용' }]);
    expect(r.text).toBe('■ 농협 (야간작업 메일보고)\n  → 야간 패치 적용');
  });

  it('기록이 없으면 null', () => {
    expect(formatWorkContent([], []).text).toBeNull();
  });
});

describe('buildSuggestions', () => {
  it('장애대응이 없는 날은 "특이사항 없음"을 제안한다', () => {
    const s = buildSuggestions([eff()], []);
    expect(s.issues.map((i) => i.text)).toEqual(['특이사항 없음']);
  });

  it('장애대응을 한 날은 그 건을 이슈·후속조치로 제안하고 "특이사항 없음"은 빼낸다', () => {
    const s = buildSuggestions([eff({ workType: '장애대응', clientName: '농협은행', startTime: at(10, 5) })], []);
    expect(s.issues.map((i) => i.text)).toEqual(['농협은행 장애대응(10:05) 처리 — 원인/조치: ']);
    expect(s.followUp.map((i) => i.text)).toContain('농협은행 장애 처리 후 재발 여부 모니터링');
    expect(isIncidentWork('장애대응')).toBe(true);
    expect(isIncidentWork('정기점검')).toBe(false);
  });

  it('종료하지 않은 작업은 후속조치와 내일 예정 업무로 제안한다', () => {
    const s = buildSuggestions([eff({ endTime: null, minutes: null, actualMinutes: null })], []);
    expect(s.followUp.map((i) => i.text)).toContain('코스콤 정기점검 잔여 작업 마무리 필요');
    expect(s.tomorrowPlan[0].text).toBe('코스콤 정기점검 정기점검 이어서 진행');
  });

  it('내일 예정 업무는 오늘 작업한 Task → 진행중 Task → 기한 임박 순으로 제안한다', () => {
    const s = buildSuggestions(
      [eff({ taskId: 't-worked' })],
      [
        task({ id: 't-todo', title: 'TODO 기한늦음', status: 'TODO', dueDate: new Date(Date.UTC(2026, 10, 30)) }),
        task({ id: 't-todo2', title: 'TODO 기한빠름', status: 'TODO', dueDate: new Date(Date.UTC(2026, 9, 20)) }),
        task({ id: 't-prog', title: '진행중 건', status: 'IN_PROGRESS' }),
        task({ id: 't-worked', title: '오늘 한 건', status: 'IN_PROGRESS' }),
        task({ id: 't-done', title: '완료건', status: 'DONE' }),
        task({ id: 't-blocked', title: '막힌건', status: 'BLOCKED' }),
      ]
    );
    const texts = s.tomorrowPlan.map((t) => t.text);
    expect(texts[0]).toContain('오늘 한 건');
    expect(texts[1]).toContain('진행중 건');
    expect(texts[2]).toContain('TODO 기한빠름');
    expect(texts[2]).toContain('(기한 10/20)');
    expect(texts.join(' ')).not.toContain('완료건');
    expect(texts.join(' ')).not.toContain('막힌건');
    expect(s.tomorrowPlan[0].reason).toBe('오늘 작업한 Task예요');
  });

  it('제안은 최대 5개이고 같은 문구는 한 번만 나온다', () => {
    const many = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, title: `작업${i}` }));
    expect(buildSuggestions([], many).tomorrowPlan).toHaveLength(5);
    const dup = buildSuggestions([eff({ workType: '장애대응' }), eff({ workType: '장애대응' })], []);
    expect(dup.followUp.filter((f) => f.text.includes('재발 여부'))).toHaveLength(1);
  });

  it('내일 예정 업무 제안은 모두 서버의 "의미 있는 입력" 규칙을 통과한다', () => {
    const s = buildSuggestions([eff({ endTime: null, minutes: null, actualMinutes: null })], [task()]);
    for (const p of s.tomorrowPlan) expect(isMeaningfulPlan(p.text)).toBe(true);
  });

  it('근거가 전혀 없으면 이슈 외에는 빈 제안', () => {
    const s = buildSuggestions([], []);
    expect(s.followUp).toEqual([]);
    expect(s.tomorrowPlan).toEqual([]);
    expect(s.issues.map((i) => i.text)).toEqual(['특이사항 없음']);
  });
});

describe('durationLabel', () => {
  it('시간/분 표기', () => {
    expect(durationLabel(160)).toBe('2시간 40분');
    expect(durationLabel(120)).toBe('2시간');
    expect(durationLabel(45)).toBe('45분');
  });
});

import { useState } from 'react';
import { apiFetch } from '@/lib/api';

/**
 * 2026-10-08: 고객사별 공수관리(공수 기록) 데이터로 프로젝트를 자동 생성하는 관리자 패널.
 * 반드시 "미리보기"로 어떤 프로젝트가 만들어질지 확인한 뒤에만 "적용"할 수 있다.
 * 비슷한 이름(예: 김앤장 / 김앤장법률사무소)은 자동으로 합치지 않고, 여기서 체크한 것만 합친다.
 */
type PreviewProject = {
  key: string; name: string; clientRegistered: boolean; existingProject: { id: string; code: string } | null;
  logCount: number; totalMinutes: number; engineers: { userId: string; name: string; logCount: number }[]; engineerCount: number;
  firstDate: string; lastDate: string; status: 'ACTIVE' | 'COMPLETED'; meaningful: boolean; include: boolean; rawNames: string[];
  tasks: { title: string; logCount: number; status: string; lastDate: string }[]; taskCount: number;
};
type Preview = {
  today: string; excludedWorkTypes: string[];
  totals: { projectsToCreate: number; projectsToReuse: number; tasksToCreate: number; logsToLink: number; active: number; completed: number };
  skipped: { totalLogs: number; alreadyLinked: number; emptyClient: number; internalClient: number; excludedWorkType: number; sampleUser: number; notMeaningfulClients: number; notMeaningfulLogs: number };
  projects: PreviewProject[];
  autoMergedPairCount: number;
  similarPairs: { a: string; b: string; reason: 'CONTAINS' | 'TYPO'; aName: string; bName: string; aLogs: number; bLogs: number }[];
};
type ApplyResult = { createdProjects: number; reusedProjects: number; createdTasks: number; linkedLogs: number; addedMembers: number; failed: { name: string; message: string }[] };

function hours(minutes: number) { return `${(minutes / 60).toFixed(1)}h`; }

export default function ProjectBackfillPanel({ onApplied }: { onApplied: () => void }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mergeSel, setMergeSel] = useState<Set<string>>(new Set()); // "a||b"
  const [excludeSel, setExcludeSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [autoMerge, setAutoMerge] = useState(true);

  function toggle(set: Set<string>, value: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    setter(next);
  }
  function buildBody() {
    return {
      mergePairs: [...mergeSel].map((s) => s.split('||') as [string, string]),
      excludeKeys: [...excludeSel],
      autoMergeContains: autoMerge,
    };
  }
  async function runPreview(keepSelections = false) {
    setBusy(true); setError(''); setResult(null);
    try {
      const data = await apiFetch<Preview>('/projects/backfill/preview', { method: 'POST', body: JSON.stringify(keepSelections ? buildBody() : { autoMergeContains: autoMerge }) });
      setPreview(data);
      if (!keepSelections) { setMergeSel(new Set()); setExcludeSel(new Set()); }
    } catch (e) {
      setError(e instanceof Error ? e.message : '미리보기를 만들지 못했습니다. (시스템관리자/인사관리자 권한이 필요합니다)');
    } finally { setBusy(false); }
  }
  async function apply() {
    if (!preview) return;
    const t = preview.totals;
    const ok = window.confirm(`프로젝트 ${t.projectsToCreate}개를 새로 만들고(기존 ${t.projectsToReuse}개 재사용), 공수 ${t.logsToLink}건을 연결합니다.\n공수의 다른 내용은 바뀌지 않습니다. 진행할까요?`);
    if (!ok) return;
    setBusy(true); setError('');
    try {
      const data = await apiFetch<ApplyResult>('/projects/backfill/apply', { method: 'POST', body: JSON.stringify({ ...buildBody(), confirm: true }) });
      setResult(data); setPreview(null);
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : '적용하지 못했습니다.');
    } finally { setBusy(false); }
  }

  const included = preview?.projects.filter((p) => p.include) ?? [];
  // 제외 체크한 행도 계속 보여줘서(미리보기를 갱신해도) 체크를 다시 풀 수 있게 한다.
  const rows = preview?.projects.filter((p) => p.include || excludeSel.has(p.key)) ?? [];
  const shown = showAll ? rows : rows.slice(0, 30);

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <strong>🪄 공수 데이터로 프로젝트 자동 생성</strong>
          <div style={{ fontSize: 12, color: '#6b7594' }}>고객사별 공수관리에 쌓인 기록을 고객사 1곳 = 프로젝트 1개로 묶어 프로젝트/Task/참여자를 만듭니다. 먼저 미리보기로 확인하세요.</div>
        </div>
        <button className="secondary" style={{ width: 'auto', margin: 0 }} onClick={() => { setOpen((v) => !v); }}>{open ? '접기' : '열기'}</button>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          {error && <div className="error">{error}</div>}
          {result && (
            <div className="hint-box" style={{ marginBottom: 10 }}>
              ✅ 적용 완료 — 프로젝트 {result.createdProjects}개 생성, {result.reusedProjects}개 재사용, Task {result.createdTasks}개 생성, 공수 {result.linkedLogs}건 연결, 참여자 {result.addedMembers}명 추가.
              {result.failed.length > 0 && <div style={{ color: '#f87171' }}>일부 실패: {result.failed.map((f) => `${f.name}(${f.message})`).join(', ')}</div>}
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, margin: '0 0 8px' }}>
            <input type="checkbox" checked={autoMerge} onChange={(e) => setAutoMerge(e.target.checked)} />
            이름이 포함 관계(예: 코스콤 ⊂ 코스콤안양연구센터)면 같은 고객사로 보고 자동으로 합치기 (바꾸면 미리보기를 다시 만드세요)
          </label>
          <button disabled={busy} style={{ width: 'auto' }} onClick={() => runPreview(false)}>{busy ? '계산 중...' : preview ? '미리보기 다시 만들기' : '미리보기 만들기'}</button>

          {preview && (
            <div style={{ marginTop: 12 }}>
              <p style={{ fontSize: 13 }}>
                새 프로젝트 <strong>{preview.totals.projectsToCreate}</strong>개 (진행 {preview.totals.active} · 완료 {preview.totals.completed}) · 기존 재사용 {preview.totals.projectsToReuse}개 ·
                Task {preview.totals.tasksToCreate}개 · 연결될 공수 <strong>{preview.totals.logsToLink}</strong>건
              </p>
              <p style={{ fontSize: 12, color: '#6b7594' }}>
                제외된 공수: 고객사 미입력 {preview.skipped.emptyClient}건 · 내부업무 표기 {preview.skipped.internalClient}건 · 비고객사 업무유형({preview.excludedWorkTypes.join('/')}) {preview.skipped.excludedWorkType}건 ·
                SAMPLE 계정 {preview.skipped.sampleUser}건 · 소규모 고객사 {preview.skipped.notMeaningfulClients}곳({preview.skipped.notMeaningfulLogs}건, 연결하지 않고 둠) · 이미 연결됨 {preview.skipped.alreadyLinked}건.
                기준: 공수 2건 이상 또는 누적 8시간 이상 또는 구체 작업명이 있는 고객사 / 마지막 공수가 30일 이내면 진행, 이후는 완료.
              </p>

              {preview.autoMergedPairCount > 0 && (
                <p style={{ fontSize: 12, color: '#6b7594' }}>이름 포함 관계 {preview.autoMergedPairCount}쌍이 자동으로 합쳐졌습니다. 프로젝트 목록의 "표기"에서 합쳐진 이름을 확인하세요.</p>
              )}
              {preview.similarPairs.length > 0 && (
                <div style={{ margin: '12px 0' }}>
                  <strong style={{ fontSize: 13 }}>{autoMerge ? '합치기 확인이 더 필요한 후보(오타 의심 등) — 같은 고객사라면 체크하세요' : '이름이 비슷한 후보 — 같은 고객사라면 체크하세요 (체크한 것만 합쳐집니다)'}</strong>
                  <div className="table-scroll" style={{ maxHeight: 240, overflow: 'auto' }}>
                    <table>
                      <thead><tr><th>합치기</th><th>이름 A</th><th>이름 B</th><th>유형</th></tr></thead>
                      <tbody>
                        {preview.similarPairs.map((p) => {
                          const id = `${p.a}||${p.b}`;
                          return (
                            <tr key={id}>
                              <td><input type="checkbox" checked={mergeSel.has(id)} onChange={() => toggle(mergeSel, id, setMergeSel)} /></td>
                              <td>{p.aName} <span style={{ color: '#6b7594' }}>({p.aLogs}건)</span></td>
                              <td>{p.bName} <span style={{ color: '#6b7594' }}>({p.bLogs}건)</span></td>
                              <td>{p.reason === 'CONTAINS' ? '이름 포함' : '오타 의심'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <button className="secondary" disabled={busy} style={{ width: 'auto' }} onClick={() => runPreview(true)}>선택 반영해서 미리보기 갱신</button>
                </div>
              )}

              <strong style={{ fontSize: 13 }}>만들어질 프로젝트 ({included.length}개) — 원치 않는 것은 제외 체크</strong>
              <div className="table-scroll" style={{ maxHeight: 420, overflow: 'auto' }}>
                <table>
                  <thead><tr><th>제외</th><th>프로젝트(고객사)</th><th>공수</th><th>누적</th><th>기간</th><th>상태</th><th>엔지니어</th><th>Task</th></tr></thead>
                  <tbody>
                    {shown.map((p) => (
                      <tr key={p.key}>
                        <td><input type="checkbox" checked={excludeSel.has(p.key)} onChange={() => toggle(excludeSel, p.key, setExcludeSel)} /></td>
                        <td>
                          {p.name}
                          {p.existingProject && <span style={{ color: '#6b7594' }}> (기존 {p.existingProject.code})</span>}
                          {!p.clientRegistered && <span style={{ color: '#fbbf24' }} title="등록된 고객사(clients)와 이름이 일치하지 않아 고객사 연결 없이 만들어집니다"> ⚠</span>}
                          {p.rawNames.length > 1 && <div style={{ fontSize: 11, color: '#6b7594' }}>표기: {p.rawNames.join(' / ')}</div>}
                        </td>
                        <td>{p.logCount}건</td>
                        <td>{hours(p.totalMinutes)}</td>
                        <td>{p.firstDate} ~ {p.lastDate}</td>
                        <td>{p.status === 'ACTIVE' ? '진행' : '완료'}</td>
                        <td>{p.engineers.slice(0, 3).map((e) => e.name).join(', ')}{p.engineerCount > 3 ? ` 외 ${p.engineerCount - 3}명` : ''}</td>
                        <td>{p.taskCount > 0 ? `${p.taskCount}개: ${p.tasks.slice(0, 2).map((t) => t.title).join(', ')}${p.taskCount > 2 ? '…' : ''}` : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {rows.length > 30 && (
                <button className="secondary" style={{ width: 'auto' }} onClick={() => setShowAll((v) => !v)}>{showAll ? '상위 30개만 보기' : `전체 ${rows.length}개 보기`}</button>
              )}
              <div style={{ marginTop: 12 }}>
                <button disabled={busy || included.length === 0} style={{ width: 'auto' }} onClick={apply}>이 계획대로 적용하기</button>
                <span style={{ fontSize: 12, color: '#6b7594', marginLeft: 8 }}>※ 제외/합치기를 바꿨다면 먼저 "선택 반영해서 미리보기 갱신"을 누르세요.</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

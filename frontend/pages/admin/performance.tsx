import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import AdminHeader from '@/components/AdminHeader';
import { apiFetch, isAuthExpiredError } from '@/lib/api';

type Row = { userId:string; employeeNo:string; name:string; department:string; projectCount:number; actualMinutes:number; effortEntryCount:number; assignedTasks:number; completedTasks:number; overdueTasks:number; blockedTasks:number; plannedTaskMinutes:number; averageTaskDifficulty:number; completionRate:number|null };
type Summary = { from:string; to:string; rows:Row[] };
function fmt(d: Date) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function monthRange(d: Date) { return { from: fmt(new Date(d.getFullYear(),d.getMonth(),1)), to: fmt(new Date(d.getFullYear(),d.getMonth()+1,0)) }; }
function h(m:number) { return (m/60).toFixed(1); }

export default function PerformancePage() {
  const router=useRouter();
  const [anchor,setAnchor]=useState(new Date());
  const [data,setData]=useState<Summary|null>(null);
  const [error,setError]=useState('');
  const [loading,setLoading]=useState(true);
  const [dept,setDept]=useState('ALL');
  const range=useMemo(()=>monthRange(anchor),[anchor]);
  useEffect(()=>{
    setError(''); setLoading(true);
    apiFetch<Summary>(`/projects/performance/summary?from=${range.from}&to=${range.to}`)
      .then(setData)
      .catch(e=>{ if(isAuthExpiredError(e)) { router.push('/login'); return; } setError(e instanceof Error?e.message:'불러오지 못했습니다.'); })
      .finally(()=>setLoading(false));
  },[range.from,range.to,router]);
  const departments=useMemo(()=>Array.from(new Set((data?.rows??[]).map(r=>r.department))).sort((a,b)=>a.localeCompare(b,'ko')),[data]);
  const rows=useMemo(()=>(data?.rows??[]).filter(r=>dept==='ALL'||r.department===dept).sort((a,b)=>a.name.localeCompare(b.name,'ko')),[data,dept]);
  const totalMinutes=rows.reduce((s,r)=>s+r.actualMinutes,0); const completed=rows.reduce((s,r)=>s+r.completedTasks,0); const overdue=rows.reduce((s,r)=>s+r.overdueTasks,0);
  return <div className="admin-shell"><AdminHeader title="ESD 2.0 직원성과 대시보드"/><p className="admin-page-subtitle">순위나 자동점수 대신 프로젝트 참여·Task 결과·실공수·지연 근거를 함께 확인합니다. 보상 판단은 검증된 데이터에 기반해 관리자가 최종 결정합니다.</p>{error&&<div className="error">{error}</div>}
    <div className="toolbar"><button className="secondary" style={{width:'auto'}} onClick={()=>setAnchor(new Date(anchor.getFullYear(),anchor.getMonth()-1,1))}>‹ 이전달</button><b>{anchor.getFullYear()}년 {anchor.getMonth()+1}월</b><button className="secondary" style={{width:'auto'}} onClick={()=>setAnchor(new Date(anchor.getFullYear(),anchor.getMonth()+1,1))}>다음달 ›</button><div className="spacer"/><select className="field-select" style={{width:'auto',margin:0}} value={dept} onChange={e=>setDept(e.target.value)}><option value="ALL">전체 부서</option>{departments.map(d=><option key={d} value={d}>{d}</option>)}</select></div>
    {loading ? <p>불러오는 중...</p> : <>
    <div className="stat-row"><div className="stat-card"><div className="stat-label">대상 엔지니어</div><div className="stat-value">{rows.length}</div></div><div className="stat-card"><div className="stat-label">구조화된 실공수</div><div className="stat-value">{h(totalMinutes)}h</div><div className="stat-sub">Project FK가 연결된 기록 기준</div></div><div className="stat-card"><div className="stat-label">완료 Task</div><div className="stat-value">{completed}</div></div><div className="stat-card"><div className="stat-label">기한초과 Task</div><div className="stat-value">{overdue}</div></div></div>
    <div className="card"><div className="table-scroll"><table className="att-table"><thead><tr><th>직원</th><th>부서</th><th className="num">참여 프로젝트</th><th className="num">실공수</th><th className="num">Task 완료/배정</th><th className="num">완료율</th><th className="num">기한초과</th><th className="num">막힘</th><th className="num">평균 난이도</th><th className="num">Task 예상공수</th></tr></thead><tbody>{rows.map(r=><tr key={r.userId}><td><b>{r.name}</b><br/><small>{r.employeeNo}</small></td><td>{r.department}</td><td className="num">{r.projectCount}</td><td className="num">{h(r.actualMinutes)}h</td><td className="num">{r.completedTasks}/{r.assignedTasks}</td><td className="num">{r.completionRate==null?'-':`${r.completionRate}%`}</td><td className="num">{r.overdueTasks}</td><td className="num">{r.blockedTasks}</td><td className="num">{r.averageTaskDifficulty||'-'}</td><td className="num">{h(r.plannedTaskMinutes)}h</td></tr>)}{rows.length===0&&<tr><td colSpan={10} style={{textAlign:'center',padding:24}}>아직 프로젝트 참여 데이터가 없습니다.</td></tr>}</tbody></table></div>
      <p style={{fontSize:12,color:'#6b7280',marginTop:14}}>※ 이 화면은 자동 인사평가 점수를 산출하지 않습니다. 프로젝트 배정량·Task 난이도·실공수·완료/지연을 함께 확인하는 관리용 근거 화면입니다. 공수만 많다고 높은 성과로 판단하지 않도록 설계했습니다.</p>
    </div>
    </>}
  </div>;
}

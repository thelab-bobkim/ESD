import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
type ApprovalType = 'OVERTIME' | 'NIGHT_WORK' | 'LEAVE_CONVERSION' | 'ATTENDANCE_CORRECTION';

const TYPE_LABEL: Record<ApprovalType, string> = {
  OVERTIME: '연장근무',
  NIGHT_WORK: '야간근무',
  LEAVE_CONVERSION: '대체휴무 전환',
  ATTENDANCE_CORRECTION: '지난 근무일 퇴근 정정',
};

interface RequesterInfo { id: string; name: string; department?: { name: string } }
interface LeaveConversionInfo { id: string; convertedMinutes: number }
interface AttendanceCorrectionInfo {
  id: string;
  proposedClockOutAt: string;
  reason: string;
  attendanceRecord: { workDate: string; clockInAt: string | null; clockOutAt: string | null };
}
interface ApprovalRequestRow {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  comment: string | null;
  requester: RequesterInfo;
  leaveConversionRequest: LeaveConversionInfo | null;
  attendanceCorrectionRequest: AttendanceCorrectionInfo | null;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function hoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

const TABS: ApprovalStatus[] = ['PENDING', 'APPROVED', 'REJECTED'];

export default function ApprovalsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<ApprovalStatus>('PENDING');
  const [requests, setRequests] = useState<ApprovalRequestRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  function load() {
    setLoading(true);
    apiFetch<ApprovalRequestRow[]>(`/approval/requests?status=${tab}`)
      .then(setRequests)
      .catch((err) => {
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰') || err.message.includes('권한'))) {
          setMessage(err.message);
        }
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function approve(id: string) {
    setBusyId(id);
    setMessage(null);
    try {
      await apiFetch(`/approval/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
      setMessage('승인 처리되었습니다.');
      load();
    } catch (err) {
      const code = err instanceof Error ? (err as Error & { code?: string }).code : undefined;
      // 2026-09-08: 지난 근무일 퇴근 정정을 승인했을 때 확정될 근무시간이 최소근무시간(정책값)
      // 미만이면 서버가 승인 사유(코멘트)를 요구한다 — 여기서 그 자리에서 입력받아 같이 실어 다시 보낸다.
      if (code === 'EARLY_LEAVE_REASON_REQUIRED') {
        const comment = window.prompt(
          `${err instanceof Error ? err.message : '최소 근무시간 미만입니다.'}\n\n승인 사유를 입력하면 그대로 승인됩니다.`
        );
        if (comment && comment.trim()) {
          try {
            await apiFetch(`/approval/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({ comment: comment.trim() }) });
            setMessage('승인 처리되었습니다.');
            load();
          } catch (err2) {
            setMessage(err2 instanceof Error ? err2.message : '승인 처리에 실패했습니다.');
          }
        }
      } else {
        setMessage(err instanceof Error ? err.message : '승인 처리에 실패했습니다.');
      }
    } finally {
      setBusyId(null);
    }
  }

  // 대기중 항목을 한 번에 승인 — 새 벌크 API를 만들지 않고, 기존 단건 승인(approve)을 항목별로
  // 그대로 순서대로 호출한다(타입별 승인 부수효과를 그대로 재사용하기 위함). 실수 방지를 위해
  // 실행 전 개수를 보여주고 확인을 받는다.
  async function approveAll() {
    const pendingIds = requests.filter((r) => r.status === 'PENDING').map((r) => r.id);
    if (pendingIds.length === 0) return;
    if (!window.confirm(`대기중인 ${pendingIds.length}건을 모두 승인할까요?`)) return;
    setBulkBusy(true);
    setMessage(null);
    let okCount = 0;
    let failCount = 0;
    for (const id of pendingIds) {
      try {
        await apiFetch(`/approval/requests/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
        okCount += 1;
      } catch {
        failCount += 1;
      }
    }
    setMessage(failCount > 0 ? `${okCount}건 승인, ${failCount}건 실패했습니다.` : `${okCount}건 모두 승인 처리되었습니다.`);
    setBulkBusy(false);
    load();
  }

  async function reject(id: string) {
    const comment = window.prompt('반려 사유를 입력해주세요 (필수)');
    if (!comment || !comment.trim()) return;
    setBusyId(id);
    setMessage(null);
    try {
      await apiFetch(`/approval/requests/${id}/reject`, { method: 'POST', body: JSON.stringify({ comment: comment.trim() }) });
      setMessage('반려 처리되었습니다.');
      load();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '반려 처리에 실패했습니다.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="admin-shell">
      <AdminHeader title="승인함" />
      <p className="admin-page-subtitle">대체휴무 전환·연장/야간근무·지난 근무일 퇴근 정정 요청을 처리하세요.</p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {TABS.map((t) => (
          <button
            key={t}
            className={t === tab ? '' : 'secondary'}
            style={{ width: 'auto' }}
            onClick={() => setTab(t)}
          >
            {t === 'PENDING' ? '대기중' : t === 'APPROVED' ? '승인됨' : '반려됨'}
          </button>
        ))}
        {tab === 'PENDING' && requests.some((r) => r.status === 'PENDING') && (
          <button style={{ width: 'auto', marginLeft: 'auto' }} disabled={bulkBusy} onClick={approveAll}>
            {bulkBusy ? '일괄 승인 중...' : `✅ 전체 승인 (${requests.filter((r) => r.status === 'PENDING').length}건)`}
          </button>
        )}
      </div>

      {message && <div className="card col-full" style={{ background: '#fff4e6' }}>{message}</div>}

      <div className="card col-full">
        {loading && <p>불러오는 중...</p>}
        {!loading && requests.length === 0 && <p style={{ color: '#868e96' }}>해당 상태의 요청이 없습니다.</p>}
        {!loading && requests.map((r) => (
          <div key={r.id} style={{ borderTop: '1px solid #e9ecef', padding: '14px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div>
                <span style={{ fontWeight: 700 }}>{r.requester?.name ?? '(알 수 없음)'}</span>
                <span style={{ marginLeft: 8, fontSize: 12, padding: '2px 8px', borderRadius: 999, background: '#e7f5ff', color: '#1c7ed6' }}>
                  {TYPE_LABEL[r.type] ?? r.type}
                </span>
                <div style={{ fontSize: 12, color: '#868e96' }}>신청 {fmtDateTime(r.requestedAt)}</div>
              </div>
              {r.status === 'PENDING' && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={{ width: 'auto', margin: 0 }} disabled={busyId === r.id} onClick={() => approve(r.id)}>승인</button>
                  <button className="secondary" style={{ width: 'auto', margin: 0 }} disabled={busyId === r.id} onClick={() => reject(r.id)}>반려</button>
                </div>
              )}
            </div>

            {r.type === 'LEAVE_CONVERSION' && r.leaveConversionRequest && (
              <div style={{ fontSize: 14, marginTop: 6 }}>
                전환 신청 시간: <strong>{hoursLabel(r.leaveConversionRequest.convertedMinutes)}</strong>
              </div>
            )}

            {r.type === 'ATTENDANCE_CORRECTION' && r.attendanceCorrectionRequest && (
              <div style={{ fontSize: 14, marginTop: 6, lineHeight: 1.6 }}>
                근무일: {new Date(r.attendanceCorrectionRequest.attendanceRecord.workDate).toLocaleDateString('ko-KR')}
                {' · '}출근 {fmtDateTime(r.attendanceCorrectionRequest.attendanceRecord.clockInAt)}
                {' → '}신청 퇴근 <strong>{fmtDateTime(r.attendanceCorrectionRequest.proposedClockOutAt)}</strong>
                <div style={{ color: '#495057', marginTop: 4 }}>사유: {r.attendanceCorrectionRequest.reason}</div>
              </div>
            )}

            {r.status !== 'PENDING' && (
              <div style={{ fontSize: 12, color: '#868e96', marginTop: 6 }}>
                {r.status === 'APPROVED' ? '승인' : '반려'} {fmtDateTime(r.decidedAt)}
                {r.comment && ` · 코멘트: ${r.comment}`}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

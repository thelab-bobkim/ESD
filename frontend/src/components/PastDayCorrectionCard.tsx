import { useState } from 'react';
import { apiFetch } from '@/lib/api';

export interface PendingCorrectionRow {
  attendanceRecordId: string;
  workDate: string;
  clockInAt: string;
  latestRequest: { id: string; status: string; proposedClockOutAt: string; reason: string } | null;
}

interface Props {
  rows: PendingCorrectionRow[];
  onSubmitted: () => void;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

/** <input type="datetime-local"> 기본값 — 출근시각 + 9시간(대략적인 하루치 근무), 로컬시간 기준 */
function defaultProposedClockOut(clockInIso: string): string {
  const d = new Date(new Date(clockInIso).getTime() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CorrectionRow({ row, onSubmitted }: { row: PendingCorrectionRow; onSubmitted: () => void }) {
  const [proposedClockOutAt, setProposedClockOutAt] = useState(defaultProposedClockOut(row.clockInAt));
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (row.latestRequest?.status === 'PENDING') {
    return (
      <div style={{ padding: '10px 0', borderTop: '1px solid #4a3a12' }}>
        <strong>{fmtDate(row.workDate)}</strong> — 퇴근 {fmtClock(row.latestRequest.proposedClockOutAt)}(으)로 정정 신청함
        <div style={{ fontSize: 12, color: '#fbbf24', fontWeight: 600 }}>⏳ 승인 대기중이에요. 팀장/관리자 승인 후 반영됩니다.</div>
      </div>
    );
  }

  async function submit() {
    if (reason.trim().length < 10) {
      setError('사유를 10자 이상 입력해주세요.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await apiFetch('/attendance-correction/requests', {
        method: 'POST',
        body: JSON.stringify({
          attendanceRecordId: row.attendanceRecordId,
          proposedClockOutAt: new Date(proposedClockOutAt).toISOString(),
          reason: reason.trim(),
        }),
      });
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : '신청에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ padding: '12px 0', borderTop: '1px solid #4a3a12' }}>
      <strong>{fmtDate(row.workDate)}</strong> — 출근 {fmtClock(row.clockInAt)} 이후 퇴근 처리가 안 되어 있어요.
      {row.latestRequest?.status === 'REJECTED' && (
        <div style={{ fontSize: 12, color: '#f87171', marginTop: 2 }}>
          ↩︎ 이전 신청이 반려되었어요. 시각/사유를 다시 확인해서 재신청해주세요.
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 13, color: '#9aa5c3' }}>
          실제 퇴근 시각{' '}
          <input
            type="datetime-local"
            value={proposedClockOutAt}
            onChange={(e) => setProposedClockOutAt(e.target.value)}
          />
        </label>
      </div>
      <textarea
        style={{ width: '100%', marginTop: 8, minHeight: 50 }}
        placeholder="왜 퇴근 처리를 못 하셨는지 사유를 10자 이상 입력해주세요 (예: 퇴근 후 바로 이동하느라 깜빡했습니다)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <div style={{ color: '#f87171', fontSize: 12, marginTop: 4 }}>{error}</div>}
      <button style={{ marginTop: 8 }} disabled={submitting} onClick={submit}>
        {submitting ? '신청 중...' : '정정 신청'}
      </button>
    </div>
  );
}

/**
 * 날짜가 넘어갔는데도 퇴근 처리가 안 된 지난 근무일이 있으면 페이지 최상단에 뜬다.
 * 시스템이 임의로 퇴근시각을 채워넣지 않고, 본인이 실제 시각+사유를 입력해 신청하게 한다
 * (대체휴무 자동전환과 동일한 원칙 — core_principles 참고). 신청 후에는 팀장/HR 승인을 거쳐야
 * 실제 근태기록에 반영된다.
 */
export default function PastDayCorrectionCard({ rows, onSubmitted }: Props) {
  if (rows.length === 0) return null;
  return (
    <div
      className="card"
      style={{ background: 'rgba(245,158,11,0.10)', border: '2px solid #4a3a12', marginBottom: 16 }}
    >
      <h2 style={{ margin: 0, color: '#fbbf24' }}>⚠️ 지난 근무일 퇴근이 확인되지 않았어요</h2>
      <p style={{ fontSize: 13, color: '#9aa5c3', marginTop: 6 }}>
        아래 날짜는 출근만 기록되고 퇴근 처리가 안 되어 있어요. 실제 퇴근하신 시각을 입력해 정정
        신청해주세요 — 신청하기 전까지는 오늘의 상태 아이콘(재택/본사근무 등)을 등록할 수 없어요.
      </p>
      {rows.map((row) => (
        <CorrectionRow key={row.attendanceRecordId} row={row} onSubmitted={onSubmitted} />
      ))}
    </div>
  );
}

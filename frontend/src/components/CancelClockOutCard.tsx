import { useState } from 'react';
import { apiFetch } from '@/lib/api';

export interface CancelClockOutStatus {
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reason: string;
  createdAt: string;
}

interface Props {
  clockOutAt: string;
  latestRequest: CancelClockOutStatus | null;
  onSubmitted: () => void;
}

function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

/**
 * 2026-09-16: "퇴근을 잘못 눌렀는데 되돌릴 방법이 없다"는 신고(채수권·윤유상) 반영 — 상태
 * 아이콘 오클릭엔 10분 내 되돌리기(undoInfo)가 있지만, 퇴근 버튼은 그 되돌리기 대상이 아니었다.
 * 기존 정정 신청(PastDayCorrectionCard)은 "지난 근무일 퇴근 누락"만 다뤄서 오늘 날짜 기록은
 * 애초에 신청조차 할 수 없었다(서버가 USE_NORMAL_CLOCKOUT으로 거절). 이 카드는 오늘 퇴근을
 * 취소해 다시 근무중 상태로 되돌리는 별도 신청 — 근태 기록을 되돌리는 것이라 자동 반영하지
 * 않고 팀장/HR 승인을 거쳐야 실제 반영된다(attendance-correction.routes.ts /cancel-clock-out 참고).
 */
export default function CancelClockOutCard({ clockOutAt, latestRequest, onSubmitted }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (latestRequest?.status === 'PENDING') {
    return (
      <div className="board-empty" style={{ marginTop: 6, color: '#fbbf24', fontWeight: 600 }}>
        ⏳ 퇴근 취소 신청이 승인 대기중이에요. 팀장/관리자 승인 후 다시 상태를 등록할 수 있어요.
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
      await apiFetch('/attendance-correction/cancel-clock-out', {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setOpen(false);
      setReason('');
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : '신청에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div>
        {latestRequest?.status === 'REJECTED' && (
          <div style={{ fontSize: 12, color: '#f87171', marginTop: 4 }}>
            ↩︎ 이전 취소 신청이 반려되었어요({latestRequest.reason}). 필요하면 다시 신청해주세요.
          </div>
        )}
        <button
          type="button"
          className="secondary"
          style={{ width: 'auto', marginTop: 6, fontSize: 12, padding: '5px 10px' }}
          onClick={() => setOpen(true)}
        >
          퇴근을 잘못 누르셨나요? 취소 신청하기
        </button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8, padding: 10, borderRadius: 10, border: '1px solid #4a3a12', background: 'rgba(245,158,11,0.10)' }}>
      <div style={{ fontSize: 13, color: '#9aa5c3' }}>
        {fmtClock(clockOutAt)}에 처리된 퇴근을 취소하고 다시 근무중 상태로 되돌리는 신청이에요. 팀장/HR 승인 후 반영돼요.
      </div>
      <textarea
        style={{ width: '100%', marginTop: 8, minHeight: 50 }}
        placeholder="예: 이동중을 누른다는 게 실수로 퇴근을 눌렀습니다."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {error && <div style={{ color: '#f87171', fontSize: 12, marginTop: 4 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button style={{ width: 'auto', margin: 0 }} disabled={submitting} onClick={submit}>
          {submitting ? '신청 중...' : '취소 신청'}
        </button>
        <button className="secondary" style={{ width: 'auto', margin: 0 }} disabled={submitting} onClick={() => setOpen(false)}>
          닫기
        </button>
      </div>
    </div>
  );
}

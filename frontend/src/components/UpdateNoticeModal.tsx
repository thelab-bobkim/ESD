import { useEffect, useState } from 'react';

// 새 공지를 올릴 때는 NOTICE_VERSION 값만 바꾸면 모든 직원에게 다시 한 번 뜬다.
const NOTICE_VERSION = '2026-10-27-update';
const STORAGE_KEY = 'tsb-update-notice-seen';

const ITEMS: { title: string; body: string }[] = [
  { title: '위치가 안 잡혀도 등록할 수 있어요', body: '위치가 많이 어긋나거나 GPS가 안 잡히면 안내창 아래의 “내 현재 위치로 등록”을 눌러 주세요. 사유(5자 이상), 현재 위치, 고객사 이름을 적으면 지금 계신 위치로 등록됩니다. 기록은 관리자가 확인해서 시스템 개선에 사용합니다.' },
  { title: '새벽에 퇴근해도 전날 기록에 이어져요', body: '야간작업 후 새벽 3시가 넘어 퇴근하셔도 “출근 기록이 없다”고 나오지 않습니다.' },
  { title: '퇴근 시 일지 작성이 편해졌어요', body: '도우미 문구는 참고용이며 입력칸에서 자유롭게 고칠 수 있고, “내일 예정 업무에 이어쓰기” 버튼이 생겼습니다.' },
  { title: '내 성과 > 내가 한 일이 날짜별로 보여요', body: '날짜마다 출근·퇴근 시각, 상태, 방문 고객사, 작업 내용과 작업 시간이 한눈에 나옵니다.' },
  { title: '이동중 알림은 1시간마다 한 번', body: '이동중 상태가 계속되면 1시간 간격으로 알려드립니다.' },
  { title: '고객사 담당자는 이름만 필수', body: '전화번호는 선택 입력입니다.' },
  { title: '작업 시간 오류를 바로잡았어요', body: '하루가 넘게 잡히던 비정상적인 작업 시간이 더는 생기지 않습니다.' },
];

export default function UpdateNoticeModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== NOTICE_VERSION) setOpen(true);
    } catch {
      setOpen(true);
    }
  }, []);

  function close() {
    try {
      window.localStorage.setItem(STORAGE_KEY, NOTICE_VERSION);
    } catch {
      /* 저장이 막힌 브라우저에서는 이번 화면에서만 닫힌다 */
    }
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="card" role="dialog" aria-modal="true" style={{ maxWidth: 480, width: '100%', maxHeight: '85vh', overflowY: 'auto', margin: 0 }}>
        <h2 style={{ marginTop: 0 }}>📢 업데이트 안내</h2>
        <p style={{ marginTop: 0 }}>그동안 주신 의견을 반영해 아래 7가지를 고쳤습니다.</p>
        <ol style={{ paddingLeft: 20, margin: '0 0 12px' }}>
          {ITEMS.map((it) => (
            <li key={it.title} style={{ marginBottom: 10 }}>
              <strong>{it.title}</strong>
              <div style={{ fontSize: 14, opacity: 0.85 }}>{it.body}</div>
            </li>
          ))}
        </ol>
        <p style={{ fontSize: 13, opacity: 0.7, margin: '0 0 12px' }}>불편한 점은 언제든 피드백백 메뉴로 남겨 주세요.</p>
        <button onClick={close}>확인했어요</button>
      </div>
    </div>
  );
}

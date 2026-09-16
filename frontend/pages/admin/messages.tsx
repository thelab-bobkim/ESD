import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/api';
import AdminHeader from '@/components/AdminHeader';

interface Conversation {
  userId: string;
  name: string;
  employeeNo: string;
  department: string;
  lastMessage: string;
  lastMessageAt: string;
  lastMessageFromAdmin: boolean;
  unreadCount: number;
}
interface ThreadMessage { id: string; message: string; senderIsAdmin: boolean; sentByName: string; createdAt: string }
interface BoardScopeUser { id: string; name: string; employeeNo: string; department: { id: string; name: string } }

function timeAgo(iso: string | null): string {
  if (!iso) return '-';
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return '방금 전';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return new Date(iso).toLocaleDateString('ko-KR');
}

const POLL_INTERVAL_MS = 20000; // 20초마다 새 답장 확인(상황판 15초 폴링과 비슷한 수준)

/**
 * "메시지함" — 관리자↔직원 양방향 메시지(2026-09-15, 상황판 아바타 클릭으로 처음 추가된 기능)를
 * 전용 메뉴에서도 볼 수 있게 한 화면(2026-09-16). 기존엔 상황판에서 직원 아바타를 눌러야만
 * 대화를 열 수 있어서, 이미 나눈 대화 전체를 훑어보거나 상황판에 안 뜨는(퇴근완료 등) 직원에게
 * 새로 말을 걸 방법이 없었다. 대화 목록/전송 로직은 messages.routes.ts를 그대로 재사용하고,
 * 대화창 UI도 상황판(dashboard.tsx)의 메시지 모달과 동일한 구조를 따른다.
 *
 * 피드백함에서 "조치완료"로 표시하면 이 기능(AdminMessage)을 통해 작성자에게 자동으로 처리완료
 * 안내가 발송된다(pilot.routes.ts 참고) — 그 안내에 대한 직원의 답장도 여기서 확인할 수 있다.
 */
export default function AdminMessagesPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 새 메시지를 보낼 직원을 고르는 패널 — 대화 이력이 없는 직원에게도 먼저 말을 걸 수 있게
  // 표시 대상 관리(board-scope) 화면과 같은 API(/users/board-scope)로 전체 재직 인원을 불러온다.
  const [showNewMessagePanel, setShowNewMessagePanel] = useState(false);
  const [employees, setEmployees] = useState<BoardScopeUser[] | null>(null);
  const [employeeSearch, setEmployeeSearch] = useState('');

  // 대화창 — dashboard.tsx의 메시지 모달과 동일한 상태/흐름(messages.routes.ts thread/admin/reply 재사용).
  const [messageTarget, setMessageTarget] = useState<{ userId: string; name: string } | null>(null);
  const [messageThread, setMessageThread] = useState<ThreadMessage[] | null>(null);
  const [loadingThread, setLoadingThread] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [messageResult, setMessageResult] = useState<string | null>(null);

  function loadConversations() {
    apiFetch<Conversation[]>('/messages/admin/conversations')
      .then(setConversations)
      .catch((err) => {
        if (err instanceof Error && (err.message.includes('로그인') || err.message.includes('토큰'))) router.push('/login');
        setError(err instanceof Error ? err.message : '오류가 발생했습니다.');
      });
  }

  useEffect(() => {
    loadConversations();
    const id = setInterval(loadConversations, POLL_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadEmployeesIfNeeded() {
    if (employees) return;
    apiFetch<BoardScopeUser[]>('/users/board-scope')
      .then(setEmployees)
      .catch((err) => setError(err instanceof Error ? err.message : '직원 목록을 불러오지 못했습니다.'));
  }

  async function openMessageModal(userId: string, name: string) {
    setMessageTarget({ userId, name });
    setMessageText('');
    setMessageResult(null);
    setMessageThread(null);
    setLoadingThread(true);
    setShowNewMessagePanel(false);
    try {
      const thread = await apiFetch<ThreadMessage[]>(`/messages/thread/${userId}`);
      setMessageThread(thread);
      // 대화창을 여는 순간 서버가 그 직원의 안 읽은 답장을 전부 읽음 처리하므로, 목록의 배지도
      // 바로 사라지도록 즉시 새로고침한다.
      loadConversations();
    } catch {
      setMessageThread([]);
    } finally {
      setLoadingThread(false);
    }
  }

  function closeMessageModal() {
    setMessageTarget(null);
    setMessageThread(null);
    setMessageResult(null);
  }

  async function sendAdminMessage() {
    if (!messageTarget || !messageText.trim()) return;
    setSendingMessage(true);
    try {
      const sent = messageText.trim();
      await apiFetch('/messages/admin', {
        method: 'POST',
        body: JSON.stringify({ userId: messageTarget.userId, message: sent }),
      });
      setMessageThread((prev) => [
        ...(prev ?? []),
        { id: `local-${Date.now()}`, message: sent, senderIsAdmin: true, sentByName: '관리자', createdAt: new Date().toISOString() },
      ]);
      setMessageText('');
      loadConversations();
    } catch (e) {
      setMessageResult(e instanceof Error ? e.message : '메시지 전송에 실패했습니다.');
    } finally {
      setSendingMessage(false);
    }
  }

  const totalUnread = useMemo(() => (conversations ?? []).reduce((sum, c) => sum + c.unreadCount, 0), [conversations]);

  const filteredEmployees = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    const list = employees ?? [];
    if (!q) return list;
    return list.filter((e) => e.name.toLowerCase().includes(q) || e.employeeNo.toLowerCase().includes(q));
  }, [employees, employeeSearch]);

  return (
    <div className="admin-shell">
      <AdminHeader title="메시지함" />
      <p className="admin-page-subtitle">
        직원과 주고받은 메시지를 확인하고 새 메시지를 보낼 수 있습니다. (전직원 상황판에서 직원 아바타를 눌러 보낸 메시지, 피드백 처리완료 자동 안내와 같은 대화입니다.)
      </p>
      {error && <div className="error">{error}</div>}

      <div className="toolbar">
        <button
          style={{ width: 'auto' }}
          onClick={() => {
            setShowNewMessagePanel((v) => !v);
            loadEmployeesIfNeeded();
          }}
        >
          {showNewMessagePanel ? '새 메시지 닫기' : '✏️ 새 메시지 보내기'}
        </button>
        <div className="spacer" />
        <button onClick={loadConversations}>새로고침</button>
      </div>

      {showNewMessagePanel && (
        <div className="card">
          <h2>새 메시지 보낼 직원 선택</h2>
          <input
            type="text"
            placeholder="이름 또는 사번 검색"
            value={employeeSearch}
            onChange={(e) => setEmployeeSearch(e.target.value)}
          />
          {!employees && <div className="board-empty">직원 목록을 불러오는 중...</div>}
          {employees && filteredEmployees.length === 0 && <div className="board-empty">검색 결과가 없습니다.</div>}
          {employees && filteredEmployees.length > 0 && (
            <div className="table-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>부서</th>
                    <th>사번</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEmployees.map((e) => (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td>{e.department.name}</td>
                      <td className="num">{e.employeeNo}</td>
                      <td>
                        <button
                          style={{ width: 'auto', margin: 0, fontSize: 12, padding: '5px 10px' }}
                          onClick={() => openMessageModal(e.id, e.name)}
                        >
                          메시지 보내기
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>
          대화 목록{conversations && ` (${conversations.length}명${totalUnread > 0 ? ` · 안 읽은 답장 ${totalUnread}건` : ''})`}
        </h2>
        {!conversations && !error && <div className="board-empty">불러오는 중...</div>}
        {conversations && conversations.length === 0 && (
          <div className="board-empty">아직 주고받은 메시지가 없습니다. &quot;새 메시지 보내기&quot;로 먼저 말을 걸어보세요.</div>
        )}
        {conversations && conversations.length > 0 && (
          <div className="table-scroll">
            <table style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>직원</th>
                  <th>부서</th>
                  <th>최근 메시지</th>
                  <th>시각</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {conversations.map((c) => (
                  <tr
                    key={c.userId}
                    style={{ cursor: 'pointer', background: c.unreadCount > 0 ? 'rgba(59,130,246,0.06)' : undefined }}
                    onClick={() => openMessageModal(c.userId, c.name)}
                  >
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {c.name}
                      {c.unreadCount > 0 && <span className="admin-nav-badge" style={{ marginLeft: 6 }}>{c.unreadCount}</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>{c.department}</td>
                    <td style={{ maxWidth: 420, whiteSpace: 'normal', wordBreak: 'break-word', color: c.unreadCount > 0 ? undefined : '#868e96' }}>
                      {!c.lastMessageFromAdmin && <span style={{ fontWeight: 600 }}>↩ </span>}
                      {c.lastMessage}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: '#868e96' }}>{timeAgo(c.lastMessageAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        style={{ width: 'auto', margin: 0, fontSize: 12, padding: '5px 10px' }}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          openMessageModal(c.userId, c.name);
                        }}
                      >
                        대화 열기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {messageTarget && (
        <div className="quick-confirm-backdrop" onClick={() => !sendingMessage && closeMessageModal()}>
          <div className="card notice-tint-blue quick-confirm-sheet msg-thread-sheet" onClick={(e) => e.stopPropagation()}>
            📨 <strong>{messageTarget.name}</strong>님과의 메시지

            <div className="msg-thread-list">
              {loadingThread && <div className="msg-thread-loading">대화 내역을 불러오는 중...</div>}
              {!loadingThread && messageThread && messageThread.length === 0 && (
                <div className="msg-thread-loading">아직 주고받은 메시지가 없어요.</div>
              )}
              {!loadingThread &&
                messageThread?.map((m) => (
                  <div key={m.id} className={`msg-bubble-row ${m.senderIsAdmin ? 'from-admin' : 'from-employee'}`}>
                    <div className="msg-bubble">
                      <div className="msg-bubble-text">{m.message}</div>
                      <div className="msg-bubble-time">{m.senderIsAdmin ? m.sentByName : messageTarget.name} · {timeAgo(m.createdAt)}</div>
                    </div>
                  </div>
                ))}
            </div>

            {messageResult && <div className="msg-warn" style={{ marginTop: 8, padding: '6px 10px', borderRadius: 8 }}>{messageResult}</div>}

            <textarea
              className="detail-textarea"
              rows={2}
              style={{ marginTop: 10 }}
              placeholder="예: 문의하신 건 처리 완료했습니다. 확인 부탁드립니다."
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              maxLength={500}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button
                style={{ width: 'auto', margin: 0 }}
                disabled={sendingMessage || !messageText.trim()}
                onClick={sendAdminMessage}
              >
                {sendingMessage ? '보내는 중...' : '보내기'}
              </button>
              <button className="secondary" style={{ width: 'auto', margin: 0 }} disabled={sendingMessage} onClick={closeMessageModal}>
                닫기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { prisma } from './prisma';
import { getLunchWindowKST, lunchOverlapMinutes } from './attendance-helpers';

// 24시간이 지난 "진행중" 기록은 이어받지 않는다 — 그만큼 오래됐으면 실수로 못 끝낸 옛 기록일
// 가능성이 높다. 그런 경우는 이어받지 않고 새 기록으로 등록된다(기존과 동일한 동작으로 안전하게 폴백).
const CONTINUE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 2026-09-18: "실 공수시간 자동 산정"(경영관리부 요청) — 원본 소요시간(rawMinutes)에서 정책에 정한
 * 점심시간대와 실제로 겹치는 만큼만 뺀다. rawMinutes를 초과해서 빼지는 않는다(자정을 넘기는 등
 * 극단적인 경우를 대비한 방어). endTime이 없으면(진행중) 계산할 수 없으므로 null.
 */
async function computeActualMinutes(startTime: Date, endTime: Date | null, rawMinutes: number | null): Promise<number | null> {
  if (!endTime || rawMinutes == null) return null;
  const lunchWindow = await getLunchWindowKST();
  const overlap = lunchOverlapMinutes(startTime, endTime, lunchWindow);
  return Math.max(0, rawMinutes - Math.min(overlap, rawMinutes));
}

export interface EffortInput {
  workDate: Date;
  clientName: string;
  projectName: string;
  workType: string;
  startTime: Date;
  endTime: Date | null;
  description?: string;
}

/**
 * 고객사미팅/고객사작업/재택/주말작업처럼 "시작~완료"가 있는 공수 기록을 남긴다. 야간작업
 * (recordNightWork, night-work-helpers.ts)과 같은 원칙 — 완료시간 없이(진행중) 등록해둔 뒤
 * 아직 안 끝난 기록이 있으면, 새로 만들지 않고 그 기록을 그대로 이어받아 완료 처리한다
 * (2026-09-15, 박준영/이보용 피드백 — "진행중"으로 등록한 뒤 나중에 다시 열면 처음부터 새로
 * 입력해야 하는 문제 해결). 완료시간 없이 다시 제출해도(계속 진행중) 새로 만들지 않고 내용만
 * 갱신한다. 시작시각(startTime)은 최초 등록값을 그대로 유지한다 — 이게 이어받기의 핵심이다.
 *
 * 본사근무(HQ_WORKING)는 애초에 "완료"라는 개념이 없는 하루 단위 상태라 이 함수를 쓰지 않는다
 * (attendance.routes.ts EFFORT_CONTINUATION_STATUSES에서 제외 — 안 그러면 매일의 본사근무
 * 업무일지가 전부 한 기록에 계속 덮어써진다).
 */
/**
 * 2026-09-18: "같은 고객사작업을 여러 번 저장하면 그때마다 새 기록이 쌓인다"(관리자 지적 —
 * 타임라인에 0분짜리 중복이 계속 찍히고, 실공수시간도 같은 작업이 여러 번 합산돼버림) — 원인은
 * "진행중(endTime null)" 이어받기 조건만 있고, 완료시간까지 이미 채워서 등록한 뒤 같은 내용을
 * 다시 저장하는 경우는 전혀 걸러지지 않았기 때문이다. 아래에서 그 경우까지 함께 찾는다.
 *
 * 1) 진행중(endTime null)으로 남겨둔 기록 — 기존과 동일.
 * 2) 이미 완료 처리된 기록이라도, 같은 상태·같은 고객사·같은 시작~종료 시각으로 다시 등록됐으면
 *    (내용을 고쳐서 재저장한 것으로 판단) 새로 만들지 않고 그 기록을 갱신한다. 시작~종료 시각이
 *    "우연히" 완전히 같은데 실제로는 다른 작업인 경우는 사실상 없다고 봐도 안전하다.
 * CONTINUE_WINDOW_MS(24시간)를 그대로 재사용해 너무 오래된(며칠 전) 기록과 값이 겹치는 극단적인
 * 경우까지 합쳐지는 걸 막는다.
 */
async function findResubmitTarget(userId: string, status: string, data: EffortInput) {
  // 2026-09-30 수정: 예전엔 고객사명(clientName)을 안 보고 "진행중(endTime null)" 기록이면
  // 무조건 이어받았다 — 그런데 그 사이 실제로 다른 고객사를 다녀왔다면(예: A사 진행중 기록을 안
  // 닫은 채 B사 작업을 새로 저장) 전혀 다른 B사 기록이 A사의 열린 기록에 잘못 합쳐져서, A사
  // 기록은 통째로 사라지고 B사 근무시간이 A사 시작시각부터로 부풀려지는 문제가 있었다(같은 문제를
  // StatusChangeLog 쪽은 이미 "직전 로그의 상태가 같을 때만 갱신"으로 막아뒀는데, 여기 공수기록
  // 쪽엔 그 대응하는 고객사 일치 조건이 빠져 있었다). 같은 고객사·같은 상태일 때만 이어받는다.
  const openEntry = await prisma.effortLog.findFirst({
    where: {
      userId,
      sourceStatus: status,
      clientName: data.clientName,
      endTime: null,
      startTime: { gte: new Date(Date.now() - CONTINUE_WINDOW_MS) },
    },
    orderBy: { startTime: 'desc' },
  });
  if (openEntry) return openEntry;
  if (!data.endTime) return null;
  return prisma.effortLog.findFirst({
    where: {
      userId,
      sourceStatus: status,
      clientName: data.clientName,
      startTime: data.startTime,
      endTime: data.endTime,
      createdAt: { gte: new Date(Date.now() - CONTINUE_WINDOW_MS) },
    },
    orderBy: { startTime: 'desc' },
  });
}

export async function recordEffort(userId: string, status: string, data: EffortInput) {
  const target = await findResubmitTarget(userId, status, data);

  if (target) {
    const minutes = data.endTime ? Math.max(0, Math.round((data.endTime.getTime() - target.startTime.getTime()) / 60000)) : null;
    const actualMinutes = await computeActualMinutes(target.startTime, data.endTime, minutes);
    return prisma.effortLog.update({
      where: { id: target.id },
      data: {
        clientName: data.clientName,
        projectName: data.projectName,
        workType: data.workType,
        endTime: data.endTime,
        minutes,
        actualMinutes,
        description: data.description,
      },
    });
  }

  const minutes = data.endTime ? Math.max(0, Math.round((data.endTime.getTime() - data.startTime.getTime()) / 60000)) : null;
  const actualMinutes = await computeActualMinutes(data.startTime, data.endTime, minutes);
  return prisma.effortLog.create({
    data: {
      userId,
      workDate: data.workDate,
      clientName: data.clientName,
      projectName: data.projectName,
      workType: data.workType,
      startTime: data.startTime,
      endTime: data.endTime,
      minutes,
      actualMinutes,
      description: data.description,
      sourceStatus: status,
    },
  });
}

/**
 * 이 등록이 새 기록을 만드는 대신 기존 세션(진행중 이어받기든, 이미 완료된 걸 재저장하는 것이든)을
 * 그대로 갱신하게 될지, 부작용 없이 미리 확인한다. attendance.routes.ts가 상태변경 로그
 * (StatusChangeLog)를 새로 남길지 그대로 갱신할지 판단하는 데 쓴다 — 공수기록과 상태변경 로그가
 * "같은 저장을 다른 결론(하나는 갱신, 하나는 새로 생성)"으로 처리해 서로 어긋나지 않게 하기 위함.
 */
export async function willUpdateExistingEffort(userId: string, status: string, data: EffortInput): Promise<boolean> {
  return (await findResubmitTarget(userId, status, data)) !== null;
}

/** 이어받을 "진행중" 기록 조회용 — 상세폼을 다시 열 때 프론트가 미리 불러와 채워넣는다. */
export async function findOpenEffort(userId: string, status: string) {
  return prisma.effortLog.findFirst({
    where: { userId, sourceStatus: status, endTime: null, startTime: { gte: new Date(Date.now() - CONTINUE_WINDOW_MS) } },
    orderBy: { startTime: 'desc' },
  });
}

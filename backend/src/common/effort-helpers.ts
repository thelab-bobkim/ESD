import { prisma } from './prisma';

// 24시간이 지난 "진행중" 기록은 이어받지 않는다 — 그만큼 오래됐으면 실수로 못 끝낸 옛 기록일
// 가능성이 높다. 그런 경우는 이어받지 않고 새 기록으로 등록된다(기존과 동일한 동작으로 안전하게 폴백).
const CONTINUE_WINDOW_MS = 24 * 60 * 60 * 1000;

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
export async function recordEffort(userId: string, status: string, data: EffortInput) {
  const openEntry = await prisma.effortLog.findFirst({
    where: { userId, sourceStatus: status, endTime: null, startTime: { gte: new Date(Date.now() - CONTINUE_WINDOW_MS) } },
    orderBy: { startTime: 'desc' },
  });

  if (openEntry) {
    const minutes = data.endTime ? Math.max(0, Math.round((data.endTime.getTime() - openEntry.startTime.getTime()) / 60000)) : null;
    return prisma.effortLog.update({
      where: { id: openEntry.id },
      data: {
        clientName: data.clientName,
        projectName: data.projectName,
        workType: data.workType,
        endTime: data.endTime,
        minutes,
        description: data.description,
      },
    });
  }

  const minutes = data.endTime ? Math.max(0, Math.round((data.endTime.getTime() - data.startTime.getTime()) / 60000)) : null;
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
      description: data.description,
      sourceStatus: status,
    },
  });
}

/** 이어받을 "진행중" 기록 조회용 — 상세폼을 다시 열 때 프론트가 미리 불러와 채워넣는다. */
export async function findOpenEffort(userId: string, status: string) {
  return prisma.effortLog.findFirst({
    where: { userId, sourceStatus: status, endTime: null, startTime: { gte: new Date(Date.now() - CONTINUE_WINDOW_MS) } },
    orderBy: { startTime: 'desc' },
  });
}

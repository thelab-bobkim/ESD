import { DauofficeClient, type DauofficeAttendanceElement } from './dauoffice-client';

export interface AttendanceCodeGroup {
  dayWorkStatusCode: string | null;
  workGroupCode: string | null;
  shiftWorkPolicyCode: string | null;
  hasStartWorkTime: boolean;
  count: number;
  samples: Pick<
    DauofficeAttendanceElement,
    'loginId' | 'name' | 'accrualDate' | 'startWorkTime' | 'endWorkTime' | 'isWorkingDay' | 'sumWorkingHours'
  >[];
}

/**
 * 2026-09-04: "다우오피스 전사휴가현황을 우리 상황판에 연동해줄 수 있냐"는 요청에서 시작된
 * 진단용 함수. attnd-v2/attnd 응답의 dayWorkStatusCode가 휴가를 구분해주는 값인지는 다우오피스
 * 공식 문서(제공 API 종류)에 나와있지 않다 — 문서엔 "근태정보"(근태 유형/기록 등록)만 있고
 * 별도의 휴가 조회 API가 없다. 그래서 실제 응답을 코드값 조합별로 모아서 관리자가 눈으로
 * 확인하게 한다("이 코드가 휴가구나"를 실데이터로 찾기 위함).
 *
 * sync-attendance.ts(현재 라우트에서 제거된 상태 — 2026-09-01, 다우오피스가 퇴근시각을 안 줘서
 * 정정신청이 끝없이 쌓이던 문제 때문)와 달리 이 함수는 DB에 아무것도 쓰지 않는 순수 조회다.
 * 또한 sync-attendance.ts는 startWorkTime이 없는 항목(휴가처럼 출근 자체가 없는 날)을
 * 건너뛰었지만, 여기서는 그런 항목이야말로 확인 대상이라 걸러내지 않는다.
 */
export async function probeAttendanceCodes(
  startDate: string,
  endDate: string
): Promise<{ totalElements: number; groups: AttendanceCodeGroup[] }> {
  const client = new DauofficeClient();
  if (!client.isConfigured()) {
    throw new Error('DAUOFFICE_CLIENT_ID/SECRET이 설정되지 않았습니다.');
  }

  const groups = new Map<string, AttendanceCodeGroup>();
  let totalElements = 0;
  let page = 0;
  const pageSize = 100;

  while (true) {
    const pageResult = await client.getAttendanceRecords(startDate, endDate, page, pageSize);
    if (pageResult.elements.length === 0) break;
    totalElements += pageResult.elements.length;

    for (const el of pageResult.elements) {
      const hasStart = Boolean(el.startWorkTime);
      const key = `${el.dayWorkStatusCode ?? 'null'}|${el.workGroupCode ?? 'null'}|${el.shiftWorkPolicyCode ?? 'null'}|${hasStart}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          dayWorkStatusCode: el.dayWorkStatusCode ?? null,
          workGroupCode: el.workGroupCode ?? null,
          shiftWorkPolicyCode: el.shiftWorkPolicyCode ?? null,
          hasStartWorkTime: hasStart,
          count: 0,
          samples: [],
        };
        groups.set(key, group);
      }
      group.count += 1;
      // 코드 조합당 대표 사례 최대 3건만 남긴다 — 응답 크기를 억제하면서도 이름/날짜를 보고
      // "이 사람이 그날 휴가였는지" 실제로 대조해볼 수 있게.
      if (group.samples.length < 3) {
        group.samples.push({
          loginId: el.loginId,
          name: el.name,
          accrualDate: el.accrualDate,
          startWorkTime: el.startWorkTime,
          endWorkTime: el.endWorkTime,
          isWorkingDay: el.isWorkingDay,
          sumWorkingHours: el.sumWorkingHours,
        });
      }
    }

    page += 1;
    if (page >= pageResult.totalPages) break;
  }

  return { totalElements, groups: Array.from(groups.values()).sort((a, b) => b.count - a.count) };
}

import { chromium, type Browser } from 'playwright';
import { prisma } from '../../common/prisma';
import { combineDateTime } from '../../common/attendance-helpers';

/**
 * 2026-09-18: 다우오피스 "전사 휴가현황"(/ehr/app/leave/company-leave-status) 스크래핑.
 *
 * 배경: 다우오피스 공식 Open API(dauoffice-client.ts)로는 휴가 여부를 구분할 수 없다는 게 이미
 * 2026-09-04에 확인됐다(dauoffice.routes.ts 주석 참고 — attnd-v2/attnd 응답의 dayWorkStatusCode 등이
 * 이 계정에서 전부 null로만 내려와서, 출근기록 유무만으로는 "전사 휴가현황"의 실제 휴가자와 맞지
 * 않았다). 그래서 이 화면을 headless 브라우저로 직접 읽어오는 방식을 대신 쓴다.
 *
 * ⚠️ 로그인 단계(login())는 다우오피스 로그인 페이지의 실제 입력창/버튼 구조를 직접 보지 못한
 * 상태로 "일반적인 ID/PW 로그인 폼"을 가정해 작성했다 — 실제 배포 후 첫 실행에서 셀렉터가 안 맞을
 * 가능성이 높다. POST /dauoffice/leave/scrape?dryRun=true (dauoffice.routes.ts)로 먼저 확인하고,
 * 필요하면 이 파일의 login() 안 셀렉터만 다우오피스 로그인 페이지 구조에 맞게 조정하면 된다.
 *
 * 상태값(StatusChangeLog)은 건드리지 않는다 — 이 스크래핑 결과는 어디까지나 상황판에 "오늘의
 * 휴가자"를 별도로 얹어 보여주는 표시용 데이터다(관리자 확정 방향, 2026-09-18). 이 프로젝트가
 * 예전에 다우오피스 출퇴근 자동동기화를 아예 껐던 이력(attendance.routes.ts, dauoffice.routes.ts
 * 참고 — "출퇴근은 앱 안에서 직원이 직접 등록한 것만 인정한다")과 같은 이유로, 직원이 그날 앱에서
 * 직접 등록한 상태와 스크래핑 결과가 서로 충돌하지 않게 하기 위함이다.
 */

const DAUOFFICE_PORTAL_URL = process.env.DAUOFFICE_PORTAL_URL || 'https://dsti.daouoffice.com';
const LEAVE_STATUS_PATH = '/ehr/app/leave/company-leave-status';
const LOGIN_PATH = '/login'; // ⚠️ 실제 로그인 경로 확인 필요 — 다우오피스가 SSO/자체 로그인 창을 별도로 띄우면 조정 필요.

export interface ScrapedLeaveRow {
  employeeNoRaw: string | null;
  nameRaw: string;
  // 2026-09-18: 항상 문자열로 정규화한다("" = 부서 미기재) — DauofficeLeaveEntry의 멱등성 키에
  // 이 값이 들어가는데, Postgres는 UNIQUE 제약에서 NULL끼리는 서로 다른 값으로 취급해 같은 사람이
  // 부서 없이 두 번 스크래핑되면 중복 행이 생길 수 있다. null을 아예 안 쓰면 이 문제가 없다.
  departmentRaw: string;
  leaveType: string;
  usageDates: string[]; // 'YYYY-MM-DD'
  usageLabel: string; // 원본 "사용휴가" 표기, 예: '0.5d (4h 0m)'
  usageRange: string | null; // 원본 "휴가사용기간" 표기, 예: '14:00~18:00'
}

export interface MatchedLeaveEntry extends ScrapedLeaveRow {
  workDate: string; // 'YYYY-MM-DD' — usageDates 중 하나(한 행을 날짜별로 펼친 결과)
  durationLabel: '종일' | '오전반차' | '오후반차' | '반반차' | '기타';
  startHHMM: string | null;
  endHHMM: string | null;
  userId: string | null;
  matched: boolean;
}

/** "0.5d (4h 0m)" 같은 표기에서 하루 대비 비율(1, 0.5, 0.25 등)만 뽑아낸다. */
function extractDayFraction(usageLabel: string): number | null {
  const m = usageLabel.match(/([\d.]+)\s*d\b/i);
  return m ? Number(m[1]) : null;
}

/** "14:00~18:00" / "14:00-18:00" / "14:00 ~ 18:00" 등을 관대하게 파싱한다. */
function parseTimeRange(usageRange: string | null): { startHHMM: string; endHHMM: string } | null {
  if (!usageRange) return null;
  const m = usageRange.match(/(\d{1,2}:\d{2})\s*[~\-]\s*(\d{1,2}:\d{2})/);
  if (!m) return null;
  return { startHHMM: m[1], endHHMM: m[2] };
}

/**
 * 하루 대비 비율과 시간대로 종일/오전반차/오후반차/반반차를 판별한다. 오전/오후 구분은
 * 시작시각이 정오(12:00) 이전인지로 본다 — 반반차(2시간)는 대개 시작시각만으로 오전/오후 뉘앙스가
 * 크지 않아 표기만 "반반차"로 두고 시간대는 startHHMM/endHHMM로 그대로 노출한다.
 *
 * 여러 날에 걸친 휴가(예: "7d")는 이 함수를 호출하는 쪽(scrapeCompanyLeaveStatus)이 이미 날짜
 * 하나하나로 펼친 뒤 호출하므로, 정수(1 이상)면 그 각각의 날짜가 "종일"이라는 뜻이다 — 정확히
 * 1일 때만 종일로 보면 "7d"처럼 여러 날에 걸친 연차가 전부 "기타"로 잘못 분류된다.
 */
function classifyDuration(usageLabel: string, timeRange: { startHHMM: string; endHHMM: string } | null): MatchedLeaveEntry['durationLabel'] {
  const fraction = extractDayFraction(usageLabel);
  if (fraction !== null && Number.isInteger(fraction) && fraction >= 1) return '종일';
  if (fraction === 0.25) return '반반차';
  if (fraction === 0.5) {
    if (timeRange) {
      const startHour = Number(timeRange.startHHMM.split(':')[0]);
      return startHour < 12 ? '오전반차' : '오후반차';
    }
    return '오전반차'; // 시간대 정보가 없으면 관례상 오전으로 표기(관리자가 화면에서 원본 사용휴가 표기도 함께 확인 가능하게 남겨둠).
  }
  return '기타';
}

/** "2026-09-18, 2026-09-21, 2026-..." 같은 표기에서 'YYYY-MM-DD' 형태만 골라낸다. 화면 폭 때문에
 * 말줄임(...)된 경우 실제 DOM 텍스트에는 전체 목록이 들어있는 게 보통(CSS ellipsis)이라 그대로
 * 읽히지만, 혹시 진짜로 잘려 있다면 파싱되는 날짜만 저장되고 나머지는 유실될 수 있다 — 이 경우
 * "사용휴가"의 일수(예: 7d)와 파싱된 날짜 개수가 다르면 서버 로그에 경고를 남긴다. */
function parseUsageDates(cellText: string): string[] {
  const matches = cellText.match(/\d{4}-\d{2}-\d{2}/g);
  return matches ?? [];
}

/**
 * 사번(정확 매칭) → 이름+부서(느슨한 매칭) 순으로 우리 시스템 직원과 대조한다. 캡처 화면의
 * "강준희 차장"처럼 사번이 비어있는 행도 실제로 있어서 이름+부서 대체 매칭이 필요하다.
 */
async function matchUser(row: ScrapedLeaveRow): Promise<string | null> {
  if (row.employeeNoRaw) {
    const byNo = await prisma.user.findUnique({ where: { employeeNo: row.employeeNoRaw } });
    if (byNo) return byNo.id;
  }
  const nameOnly = row.nameRaw.replace(/\s*(사원|주임|대리|과장|차장|부장|이사|전무|상무|팀장|실장)\s*$/u, '').trim();
  const candidates = await prisma.user.findMany({
    where: { name: nameOnly || row.nameRaw },
    include: { department: true },
  });
  if (candidates.length === 1) return candidates[0].id;
  if (candidates.length > 1 && row.departmentRaw) {
    const byDept = candidates.find((c: { id: string; department: { name: string } }) => row.departmentRaw && c.department.name.includes(row.departmentRaw.trim()));
    if (byDept) return byDept.id;
  }
  return null; // 여러 명 중 못 좁혔거나 아예 없음 — 관리자가 admin 화면에서 매칭 실패 목록으로 확인.
}

async function login(browser: Browser): Promise<import('playwright').Page> {
  const username = process.env.DAUOFFICE_SCRAPE_USERNAME || '';
  const password = process.env.DAUOFFICE_SCRAPE_PASSWORD || '';
  if (!username || !password) {
    throw new Error('DAUOFFICE_SCRAPE_USERNAME/DAUOFFICE_SCRAPE_PASSWORD 환경변수가 설정되지 않았습니다.');
  }
  const page = await browser.newPage();
  await page.goto(`${DAUOFFICE_PORTAL_URL}${LOGIN_PATH}`, { waitUntil: 'networkidle' });

  // ⚠️ 아래 셀렉터는 실제 다우오피스 로그인 페이지를 보지 못한 상태의 추정치다(일반적인 ID/PW
  // 로그인 폼 가정). 첫 실행이 실패하면 이 블록만 실제 페이지 구조에 맞게 바꾸면 된다 — 나머지
  // (표 파싱·매칭·저장) 로직에는 영향 없다.
  const idInput = page.locator('input[name="loginId"], input[name="userId"], input[type="text"]').first();
  const pwInput = page.locator('input[name="password"], input[type="password"]').first();
  await idInput.fill(username);
  await pwInput.fill(password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => null),
    page.locator('button[type="submit"], button:has-text("로그인")').first().click(),
  ]);
  return page;
}

/**
 * "전사 휴가현황" 페이지의 표를 읽어서 파싱한 행 목록을 반환한다(저장은 하지 않음 — 순수 스크래핑).
 * 표 헤더 순서(사번/사원명/부서명/휴가유형/휴가사용일/사용휴가/휴가사용기간)를 기준으로 셀
 * 인덱스로 읽는다 — 다우오피스가 이 화면의 구조를 바꾸면 이 부분도 같이 조정해야 한다.
 */
async function readLeaveTable(page: import('playwright').Page): Promise<ScrapedLeaveRow[]> {
  await page.goto(`${DAUOFFICE_PORTAL_URL}${LEAVE_STATUS_PATH}`, { waitUntil: 'networkidle' });
  await page.locator('table tbody tr').first().waitFor({ timeout: 15000 });

  // 이 콜백은 브라우저 컨텍스트 안에서 실행된다(Playwright가 문자열로 직렬화해 페이지에 주입) —
  // 백엔드 tsconfig에는 DOM lib이 없어 Element 타입이 안 잡히므로 any로 우회한다.
  const rawRows = await page.$$eval('table tbody tr', (trs: any[]) =>
    trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td: any) => (td.textContent || '').trim()))
  );

  const rows: ScrapedLeaveRow[] = [];
  for (const cells of rawRows) {
    // [사번, 사원명, 부서명, 휴가유형, 휴가사용일, 사용휴가, 휴가사용기간]
    if (cells.length < 6) continue;
    const [employeeNo, name, department, leaveType, usageDateCell, usageLabel, usageRangeCell] = cells;
    if (!name) continue;
    const usageDates = parseUsageDates(usageDateCell);
    const expectedDays = extractDayFraction(usageLabel);
    if (expectedDays && expectedDays >= 1 && usageDates.length < Math.floor(expectedDays)) {
      // eslint-disable-next-line no-console
      console.warn(`[LeaveScraper] "${name}" 행의 사용일(${usageDates.length}개)이 사용휴가(${usageLabel})보다 적게 파싱됨 — 화면에서 날짜 목록이 실제로 잘려있을 수 있음.`);
    }
    rows.push({
      employeeNoRaw: employeeNo?.trim() || null,
      nameRaw: name.replace(/\s+/g, ' ').trim(),
      departmentRaw: department?.trim() || '',
      leaveType: leaveType?.trim() || '연차',
      usageDates,
      usageLabel: usageLabel?.trim() || '',
      usageRange: usageRangeCell?.trim() || null,
    });
  }
  return rows;
}

export interface ScrapeResult {
  scrapedRowCount: number;
  entries: MatchedLeaveEntry[];
  savedCount: number;
  unmatched: MatchedLeaveEntry[];
}

/**
 * 전체 흐름: 로그인 → 표 읽기 → 행마다(사용일 개수만큼) 날짜별로 펼치고 종일/반차/반반차 분류·
 * 직원 매칭 → dryRun이 아니면 DauofficeLeaveEntry에 upsert. 관리자 수동 실행(POST
 * /dauoffice/leave/scrape)과 스케줄러(leave-scrape-scheduler.ts) 양쪽에서 이 함수를 그대로 쓴다.
 */
export async function scrapeCompanyLeaveStatus(opts: { dryRun?: boolean } = {}): Promise<ScrapeResult> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await login(browser);
    const rawRows = await readLeaveTable(page);

    const entries: MatchedLeaveEntry[] = [];
    for (const row of rawRows) {
      const timeRange = parseTimeRange(row.usageRange);
      const durationLabel = classifyDuration(row.usageLabel, timeRange);
      const userId = await matchUser(row);
      const dates = row.usageDates.length > 0 ? row.usageDates : [];
      for (const workDate of dates) {
        entries.push({
          ...row,
          workDate,
          durationLabel,
          startHHMM: timeRange?.startHHMM ?? null,
          endHHMM: timeRange?.endHHMM ?? null,
          userId,
          matched: userId !== null,
        });
      }
    }

    let savedCount = 0;
    if (!opts.dryRun) {
      for (const entry of entries) {
        const workDateValue = new Date(`${entry.workDate}T00:00:00.000Z`);
        const startTime = entry.startHHMM ? combineDateTime(workDateValue, entry.startHHMM) : null;
        const endTime = entry.endHHMM ? combineDateTime(workDateValue, entry.endHHMM) : null;
        await prisma.dauofficeLeaveEntry.upsert({
          where: {
            workDate_nameRaw_departmentRaw_leaveType: {
              workDate: workDateValue,
              nameRaw: entry.nameRaw,
              departmentRaw: entry.departmentRaw,
              leaveType: entry.leaveType,
            },
          },
          create: {
            workDate: workDateValue,
            userId: entry.userId,
            employeeNoRaw: entry.employeeNoRaw,
            nameRaw: entry.nameRaw,
            departmentRaw: entry.departmentRaw,
            leaveType: entry.leaveType,
            durationLabel: entry.durationLabel,
            startTime,
            endTime,
            matched: entry.matched,
          },
          update: {
            userId: entry.userId,
            employeeNoRaw: entry.employeeNoRaw,
            durationLabel: entry.durationLabel,
            startTime,
            endTime,
            matched: entry.matched,
            scrapedAt: new Date(),
          },
        });
        savedCount += 1;
      }
    }

    return {
      scrapedRowCount: rawRows.length,
      entries,
      savedCount,
      unmatched: entries.filter((e) => !e.matched),
    };
  } finally {
    await browser.close();
  }
}

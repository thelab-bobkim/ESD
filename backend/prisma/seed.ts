import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function main() {
  // 1) 역할
  const roleDefs = [
    { code: 'EMPLOYEE' as const, name: '직원' },
    { code: 'TEAM_LEAD' as const, name: '팀장' },
    { code: 'HR_ADMIN' as const, name: '인사담당자' },
    { code: 'SYSTEM_ADMIN' as const, name: '시스템관리자' },
    { code: 'PILOT_MANAGER' as const, name: '파일럿운영담당' },
  ];
  const roles: Record<string, string> = {};
  for (const r of roleDefs) {
    const role = await prisma.role.upsert({ where: { code: r.code }, update: {}, create: r });
    roles[r.code] = role.id;
  }

  // 2) 부서
  const salesDept = await prisma.department.upsert({ where: { name: 'SAMPLE_영업팀' }, update: {}, create: { name: 'SAMPLE_영업팀', type: 'HQ_SALES' } });
  const engDept = await prisma.department.upsert({ where: { name: 'SAMPLE_엔지니어팀' }, update: {}, create: { name: 'SAMPLE_엔지니어팀', type: 'HQ_ENGINEER' } });
  const etcDept = await prisma.department.upsert({ where: { name: 'SAMPLE_경영지원팀' }, update: {}, create: { name: 'SAMPLE_경영지원팀', type: 'HQ_ETC' } });
  const residentDept = await prisma.department.upsert({ where: { name: 'SAMPLE_고객사상주팀' }, update: {}, create: { name: 'SAMPLE_고객사상주팀', type: 'RESIDENT' } });

  // 3) 고객사
  const clientA = await prisma.client.create({ data: { name: 'SAMPLE_A고객사', address: 'SAMPLE_서울시 강남구' } });
  const clientB = await prisma.client.create({ data: { name: 'SAMPLE_B고객사', address: 'SAMPLE_서울시 판교' } });

  // 4) 휴가 유형
  const altDayOff = await prisma.leaveType.upsert({ where: { code: 'ALT_DAY_OFF' }, update: {}, create: { code: 'ALT_DAY_OFF', name: '대체휴무' } });
  await prisma.leaveType.upsert({ where: { code: 'COMP_LEAVE' }, update: {}, create: { code: 'COMP_LEAVE', name: '보상휴가' } });
  await prisma.leaveType.upsert({ where: { code: 'ANNUAL' }, update: {}, create: { code: 'ANNUAL', name: '연차' } });

  // 5) 정책 초기값 (PRD.md 8절 참조)
  const policies: Array<{ key: string; value: string; valueType: 'BOOLEAN' | 'NUMBER' | 'STRING' | 'JSON'; description: string }> = [
    { key: 'FLEX_WORK_CORE_HOURS', value: '10:00-16:00', valueType: 'STRING', description: '탄력근무 코어타임' },
    { key: 'RESIDENT_STANDARD_HOURS', value: '09:00-18:00', valueType: 'STRING', description: '고객사 상주 표준 근무시간' },
    { key: 'NIGHT_WORK_START', value: '22:00', valueType: 'STRING', description: '야간근무 판정 시작시각' },
    { key: 'NIGHT_WORK_END', value: '06:00', valueType: 'STRING', description: '야간근무 판정 종료시각' },
    { key: 'NIGHT_WORK_COMPENSATION_TYPE', value: 'ALT_DAY_OFF', valueType: 'STRING', description: '야간근무 보상방식(ALT_DAY_OFF/COMP_LEAVE)' },
    { key: 'NIGHT_TO_LEAVE_CONVERSION_RATE', value: '1:1', valueType: 'STRING', description: '야간근무시간 대비 휴가 전환비율' },
    { key: 'OVERTIME_APPROVAL_REQUIRED', value: 'true', valueType: 'BOOLEAN', description: '초과근무 승인 필수 여부' },
    { key: 'OVERTIME_WARNING_THRESHOLD_HOURS', value: '12', valueType: 'NUMBER', description: '장시간근무 경고 기준(시간)' },
    { key: 'BREAK_MINIMUM_MINUTES', value: '30', valueType: 'NUMBER', description: '4시간당 최소 휴게시간(분)' },
    { key: 'UNCONFIRMED_STATUS_ALERT_MINUTES', value: '120', valueType: 'NUMBER', description: '상태 미확인 경고 기준(분)' },
    { key: 'DATA_RETENTION_MONTHS', value: '36', valueType: 'NUMBER', description: '근태 로그 보관기간(개월)' },
    { key: 'ENABLE_GPS_TRACKING', value: 'false', valueType: 'BOOLEAN', description: '실시간 GPS 추적 여부(기본 비활성화)' },
    // 다우오피스 연동 관련 정책값 (DAUOFFICE_INTEGRATION.md 참조)
    { key: 'DAUOFFICE_AUTO_SYNC_ENABLED', value: 'false', valueType: 'BOOLEAN', description: '다우오피스 자동 동기화 사용 여부(기본 꺼짐 — 수동 검증 후 관리자가 켤 것)' },
    { key: 'DAUOFFICE_SYNC_INTERVAL_HOURS', value: '6', valueType: 'NUMBER', description: '다우오피스 자동 동기화 주기(시간)' },
    { key: 'DAUOFFICE_SYNCED_DEFAULT_PASSWORD', value: 'CONFIGURABLE_change_me_1234', valueType: 'STRING', description: '다우오피스로 신규 동기화된 계정의 초기 비밀번호(반드시 변경 권장)' },
    { key: 'DAUOFFICE_AUTO_DEACTIVATE_MANUAL_DUPLICATES', value: 'false', valueType: 'BOOLEAN', description: '수동입력 직원과 이름이 같은 다우오피스 동기화 직원이 있으면 수동입력 쪽을 자동 비활성화할지 여부' },
    { key: 'DEFAULT_SYNCED_WORK_TYPE', value: 'HQ_FIXED', valueType: 'STRING', description: '부서명 패턴에 안 걸리는 동기화 직원의 기본 근무유형' },
    {
      key: 'DEPARTMENT_WORKTYPE_RULES',
      value: JSON.stringify([
        { pattern: '상주', workType: 'RESIDENT' },
        { pattern: 'CS', workType: 'HQ_FLEX' },
        { pattern: '영업', workType: 'HQ_FLEX' },
        { pattern: '사업부', workType: 'HQ_FLEX' },
        { pattern: '기술지원', workType: 'HQ_FLEX' },
      ]),
      valueType: 'JSON',
      description: '부서명 패턴 → 근무유형(HQ_FLEX/HQ_FIXED/RESIDENT) 자동 매핑 규칙(위에서부터 순서대로 첫 일치 적용)',
    },
  ];
  for (const p of policies) {
    const existing = await prisma.policySetting.findFirst({ where: { key: p.key, scopeDepartmentId: null } });
    if (!existing) {
      await prisma.policySetting.create({ data: { ...p, scopeDepartmentId: null } });
    }
  }

  // 5-1) 다우오피스 부서명 수동 보정값 (조직도 API가 부서를 못 내려주는 계정 보정용)
  const overridesPath = path.join(__dirname, 'seed-data', 'dauoffice-department-overrides.json');
  if (fs.existsSync(overridesPath)) {
    const overrides: Record<string, string> = JSON.parse(fs.readFileSync(overridesPath, 'utf-8'));
    for (const [loginId, departmentName] of Object.entries(overrides)) {
      await prisma.dauofficeDepartmentOverride.upsert({
        where: { dauofficeLoginId: loginId },
        update: { departmentName },
        create: { dauofficeLoginId: loginId, departmentName },
      });
    }
    console.log(`다우오피스 부서 보정값 ${Object.keys(overrides).length}건 시드 완료`);
  }

  // 6) 알림 규칙
  const alertRuleCodes = ['NO_CLOCK_IN', 'LONG_WORKING', 'NIGHT_WORK_NOT_CONVERTED', 'STATUS_NOT_CONFIRMED'];
  for (const code of alertRuleCodes) {
    await prisma.alertRule.upsert({ where: { code }, update: {}, create: { code, enabled: true } });
  }

  // 7) 사용자 (시나리오 커버: 영업, 엔지니어, 고객사 상주, 관리자/HR/시스템관리자)
  const passwordHash = await bcrypt.hash('SAMPLE_pass1234', 10);

  async function createUser(opts: {
    employeeNo: string;
    name: string;
    email: string;
    departmentId: string;
    workType: 'HQ_FLEX' | 'HQ_FIXED' | 'RESIDENT';
    assignedClientId?: string;
    roleCodes: string[];
  }) {
    const user = await prisma.user.create({
      data: {
        employeeNo: opts.employeeNo,
        name: opts.name,
        email: opts.email,
        passwordHash,
        departmentId: opts.departmentId,
        workType: opts.workType,
        assignedClientId: opts.assignedClientId,
      },
    });
    for (const code of opts.roleCodes) {
      await prisma.userRole.create({ data: { userId: user.id, roleId: roles[code] } });
    }
    return user;
  }

  const salesEmployee = await createUser({
    employeeNo: 'SAMPLE_S001', name: 'SAMPLE_영업직원', email: 'sales1@sample.local',
    departmentId: salesDept.id, workType: 'HQ_FLEX', roleCodes: ['EMPLOYEE'],
  });
  const engEmployee = await createUser({
    employeeNo: 'SAMPLE_E001', name: 'SAMPLE_엔지니어', email: 'eng1@sample.local',
    departmentId: engDept.id, workType: 'HQ_FLEX', roleCodes: ['EMPLOYEE'],
  });
  await createUser({
    employeeNo: 'SAMPLE_R001', name: 'SAMPLE_상주직원A', email: 'resident1@sample.local',
    departmentId: residentDept.id, workType: 'RESIDENT', assignedClientId: clientA.id, roleCodes: ['EMPLOYEE'],
  });
  await createUser({
    employeeNo: 'SAMPLE_R002', name: 'SAMPLE_상주직원B', email: 'resident2@sample.local',
    departmentId: residentDept.id, workType: 'RESIDENT', assignedClientId: clientB.id, roleCodes: ['EMPLOYEE'],
  });
  await createUser({
    employeeNo: 'SAMPLE_T001', name: 'SAMPLE_엔지니어팀장', email: 'teamlead1@sample.local',
    departmentId: engDept.id, workType: 'HQ_FIXED', roleCodes: ['EMPLOYEE', 'TEAM_LEAD'],
  });
  await createUser({
    employeeNo: 'SAMPLE_H001', name: 'SAMPLE_인사담당자', email: 'hr1@sample.local',
    departmentId: etcDept.id, workType: 'HQ_FIXED', roleCodes: ['EMPLOYEE', 'HR_ADMIN', 'PILOT_MANAGER'],
  });
  await createUser({
    employeeNo: 'SAMPLE_A001', name: 'SAMPLE_시스템관리자', email: 'admin1@sample.local',
    departmentId: etcDept.id, workType: 'HQ_FIXED', roleCodes: ['EMPLOYEE', 'SYSTEM_ADMIN'],
  });

  // 8) 파일럿 그룹 예시
  const pilotGroup = await prisma.pilotGroup.create({
    data: {
      name: 'SAMPLE_1차 파일럿',
      description: '영업/엔지니어/고객사상주 소규모 파일럿',
      startDate: new Date(),
      endDate: new Date(Date.now() + 28 * 24 * 60 * 60 * 1000),
    },
  });
  await prisma.pilotGroupMember.createMany({
    data: [salesEmployee.id, engEmployee.id].map((userId) => ({ pilotGroupId: pilotGroup.id, userId })),
  });

  // eslint-disable-next-line no-console
  console.log('시드 데이터 생성 완료. 로그인 계정 비밀번호는 모두 SAMPLE_pass1234 입니다.');
  console.log('예: sales1@sample.local / eng1@sample.local / resident1@sample.local / teamlead1@sample.local / hr1@sample.local / admin1@sample.local');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

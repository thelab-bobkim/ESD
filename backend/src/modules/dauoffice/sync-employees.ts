import bcrypt from 'bcryptjs';
import { prisma } from '../../common/prisma';
import { recordAuditLog } from '../../common/audit';
import { getPolicyBoolean, getPolicyString } from '../../common/policy-engine/policy-engine';
import { DauofficeClient } from './dauoffice-client';
import { isLikelyDepartmentNode, resolveDepartmentName, resolveWorkType } from './department-resolver';

export interface EmployeeSyncResult {
  synced: number;
  skippedDeptNodes: number;
  deactivated: number;
  errors: string[];
}

/**
 * 다우오피스 직원 목록을 ESD의 Department/User 테이블로 동기화한다.
 * (AMS의 sync_employees_from_dauoffice 이식, 정책값 분리 원칙에 맞게 일부 재구성)
 *
 * 안전장치:
 * - 실제 운영 데이터에 영향을 주므로 "수동입력 직원과 이름이 같으면 비활성화" 동작은
 *   기본적으로 꺼져 있고(DAUOFFICE_AUTO_DEACTIVATE_MANUAL_DUPLICATES=false), 관리자가 정책값으로 켜야 동작한다.
 * - 모든 변경은 감사로그(POLICY_CHANGE 아님, STATUS_CHANGE로 target_type='dauoffice_sync')에 요약 기록된다.
 */
export async function syncEmployeesFromDauoffice(actorUserId: string | null): Promise<EmployeeSyncResult> {
  const client = new DauofficeClient();
  const result: EmployeeSyncResult = { synced: 0, skippedDeptNodes: 0, deactivated: 0, errors: [] };

  if (!client.isConfigured()) {
    result.errors.push('DAUOFFICE_CLIENT_ID/SECRET이 설정되지 않았습니다.');
    return result;
  }

  const employeesData = await client.getOrganizationInfo();
  if (employeesData.length === 0) {
    result.errors.push('다우오피스에서 받아온 직원 데이터가 없습니다.');
    return result;
  }

  const employeeRole = await prisma.role.findUnique({ where: { code: 'EMPLOYEE' } });
  const defaultPassword = await getPolicyString('DAUOFFICE_SYNCED_DEFAULT_PASSWORD', 'CONFIGURABLE_change_me_1234');
  const defaultPasswordHash = await bcrypt.hash(defaultPassword, 10);

  const processedLoginIds = new Set<string>();

  // ── PHASE 1: 다우오피스 계정 upsert ──────────────────────────────────
  for (const emp of employeesData) {
    const loginId = (emp.loginId ?? '').trim();
    if (!loginId) continue;

    try {
      if (await isLikelyDepartmentNode(emp)) {
        result.skippedDeptNodes += 1;
        continue;
      }

      if (emp.status !== 'NORMAL') {
        const existing = await prisma.user.findUnique({ where: { dauofficeUserId: loginId } });
        if (existing && existing.employmentStatus !== 'TERMINATED') {
          await prisma.user.update({ where: { id: existing.id }, data: { employmentStatus: 'TERMINATED' } });
          result.deactivated += 1;
        }
        continue;
      }

      processedLoginIds.add(loginId);

      const departmentName = await resolveDepartmentName(emp);
      if (!departmentName) {
        result.errors.push(`부서명을 판정하지 못해 건너뜀: ${emp.name}(${loginId})`);
        continue;
      }
      const department = await prisma.department.upsert({
        where: { name: departmentName },
        update: {},
        create: { name: departmentName, type: null },
      });
      const workType = await resolveWorkType(departmentName);

      const existing = await prisma.user.findUnique({ where: { dauofficeUserId: loginId } });
      if (existing) {
        await prisma.user.update({
          where: { id: existing.id },
          data: {
            name: emp.name,
            departmentId: department.id,
            workType,
            employmentStatus: 'ACTIVE',
            dataSource: 'DAUOFFICE',
          },
        });
      } else {
        const created = await prisma.user.create({
          data: {
            employeeNo: loginId,
            name: emp.name,
            email: null,
            passwordHash: defaultPasswordHash,
            departmentId: department.id,
            workType,
            employmentStatus: 'ACTIVE',
            dauofficeUserId: loginId,
            dataSource: 'DAUOFFICE',
          },
        });
        if (employeeRole) {
          await prisma.userRole.create({ data: { userId: created.id, roleId: employeeRole.id } });
        }
      }
      result.synced += 1;
    } catch (err) {
      result.errors.push(`${emp.name ?? ''}(${loginId}) 처리 중 오류: ${(err as Error).message}`);
    }
  }

  // ── PHASE 2(선택): 동일 이름 수동입력 직원 비활성화 — 기본 비활성화된 정책 ──
  const autoDeactivateManualDup = await getPolicyBoolean('DAUOFFICE_AUTO_DEACTIVATE_MANUAL_DUPLICATES', false);
  if (autoDeactivateManualDup) {
    const manualActiveUsers = await prisma.user.findMany({
      where: { dataSource: 'MANUAL', employmentStatus: 'ACTIVE', dauofficeUserId: null },
    });
    for (const m of manualActiveUsers) {
      const dup = await prisma.user.findFirst({
        where: { name: m.name, dataSource: 'DAUOFFICE', employmentStatus: 'ACTIVE' },
      });
      if (dup) {
        await prisma.user.update({ where: { id: m.id }, data: { employmentStatus: 'TERMINATED' } });
      }
    }
  }

  // ── PHASE 3: 이번 sync에 없던 기존 다우오피스 동기화 직원 → 퇴사 처리 ──
  if (processedLoginIds.size > 0) {
    const orphans = await prisma.user.findMany({
      where: {
        dataSource: 'DAUOFFICE',
        employmentStatus: 'ACTIVE',
        dauofficeUserId: { not: null, notIn: Array.from(processedLoginIds) },
      },
    });
    for (const o of orphans) {
      await prisma.user.update({ where: { id: o.id }, data: { employmentStatus: 'TERMINATED' } });
      result.deactivated += 1;
    }
  }

  await recordAuditLog({
    actorUserId,
    actionType: 'STATUS_CHANGE',
    targetType: 'dauoffice_sync_employees',
    afterValue: result,
  });

  return result;
}

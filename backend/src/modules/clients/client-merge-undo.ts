import { prisma } from '../../common/prisma';
import { recordAuditLog } from '../../common/audit';
import { MergeUndoError } from './client-merge-snapshot';

/** 합치기를 되돌린다 — 삭제됐던 고객사를 같은 ID로 다시 만들고, 옮겨졌던 항목들을 원래 고객사로 돌려놓는다. */
export async function undoClientMerge(auditId: string, actorUserId: string | null) {
  const log = await prisma.auditLog.findUnique({ where: { id: auditId } });
  if (!log || log.targetType !== 'client_merge') throw new MergeUndoError('NOT_FOUND', '합치기 기록을 찾을 수 없어요.');
  const undo: any = (log.afterValue as any)?.undo;
  if (!undo?.removed?.length) throw new MergeUndoError('NOT_UNDOABLE', '이전 방식으로 합친 기록이라 자동으로 되돌릴 수 없어요.');
  const done = await prisma.auditLog.findFirst({ where: { targetType: 'client_merge_undo', targetId: auditId } });
  if (done) throw new MergeUndoError('ALREADY_UNDONE', '이미 되돌린 합치기예요.');
  const keep = await prisma.client.findUnique({ where: { id: undo.keepId } });
  if (!keep) throw new MergeUndoError('KEEP_MISSING', '남아 있던 고객사가 이미 삭제되어 되돌릴 수 없어요.');
  await prisma.$transaction(async (tx) => {
    for (const r of undo.removed) {
      const c = r.client;
      if (await tx.client.findUnique({ where: { id: c.id } })) throw new MergeUndoError('CONFLICT', `'${c.name}' 고객사가 이미 있어 되돌릴 수 없어요.`);
      await tx.client.create({ data: { id: c.id, name: c.name, address: c.address, latitude: c.latitude, longitude: c.longitude } });
      if (r.userIds.length) await tx.user.updateMany({ where: { id: { in: r.userIds }, assignedClientId: undo.keepId }, data: { assignedClientId: c.id } });
      if (r.checkinIds.length) await tx.residentCheckin.updateMany({ where: { id: { in: r.checkinIds }, clientId: undo.keepId }, data: { clientId: c.id } });
      if (r.projectIds.length) await tx.project.updateMany({ where: { id: { in: r.projectIds }, clientId: undo.keepId }, data: { clientId: c.id } });
      for (const k of r.contacts) {
        const cur = await tx.clientContact.findUnique({ where: { id: k.id } });
        if (cur) {
          if (cur.clientId === undo.keepId) await tx.clientContact.update({ where: { id: k.id }, data: { clientId: c.id } });
          continue;
        }
        await tx.clientContact.create({
          data: {
            id: k.id, clientId: c.id, name: k.name, phone: k.phone, email: k.email, department: k.department,
            createdBy: k.createdBy, createdAt: new Date(k.createdAt), useCount: k.useCount, isActive: k.isActive,
            lastUsedAt: k.lastUsedAt ? new Date(k.lastUsedAt) : null,
          },
        });
        const eids = r.contactEfforts?.[k.id] ?? [];
        if (eids.length) await tx.effortLog.updateMany({ where: { id: { in: eids } }, data: { contactId: k.id } });
      }
      if (r.renamedEffort && r.effortIds.length) await tx.effortLog.updateMany({ where: { id: { in: r.effortIds }, clientName: keep.name }, data: { clientName: c.name } });
    }
    if (undo.coordinatesCopied) await tx.client.update({ where: { id: undo.keepId }, data: { latitude: undo.keepBefore?.latitude ?? null, longitude: undo.keepBefore?.longitude ?? null } });
    await recordAuditLog({
      actorUserId, actionType: 'CORRECT', targetType: 'client_merge_undo', targetId: auditId,
      afterValue: { keep: keep.name, restored: undo.removed.map((r: any) => r.client.name) },
    }, tx);
  }, { timeout: 60000 });
  return { keep: keep.name, restored: undo.removed.map((r: any) => r.client.name) as string[] };
}

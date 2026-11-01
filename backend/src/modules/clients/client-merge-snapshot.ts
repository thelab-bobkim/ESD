import type { Prisma } from '@prisma/client';
import { prisma } from '../../common/prisma';

export class MergeUndoError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** 합치기 직전의 상태(삭제될 고객사와 거기 붙어 있던 항목들)를 기록한다 — 되돌리기에 쓴다. */
export async function collectMergeSnapshot(tx: Prisma.TransactionClient, r: any, renamed: boolean) {
  const ids = (rows: any[]) => rows.map((x) => x.id);
  const users = await tx.user.findMany({ where: { assignedClientId: r.id }, select: { id: true } });
  const checkins = await tx.residentCheckin.findMany({ where: { clientId: r.id }, select: { id: true } });
  const projects = await tx.project.findMany({ where: { clientId: r.id }, select: { id: true } });
  const contacts = await tx.clientContact.findMany({ where: { clientId: r.id } });
  const cids: any[] = contacts.map((c) => c.id);
  const links = cids.length ? await tx.effortLog.findMany({ where: { contactId: { in: cids } }, select: { id: true, contactId: true } }) : [];
  const contactEfforts: Record<string, any[]> = {};
  for (const l of links) {
    const k = String(l.contactId);
    if (!contactEfforts[k]) contactEfforts[k] = [];
    contactEfforts[k].push(l.id);
  }
  const efforts = renamed ? await tx.effortLog.findMany({ where: { clientName: r.name }, select: { id: true } }) : [];
  return {
    client: { id: r.id, name: r.name, address: r.address, latitude: r.latitude, longitude: r.longitude },
    userIds: ids(users), checkinIds: ids(checkins), projectIds: ids(projects),
    contacts: JSON.parse(JSON.stringify(contacts)), contactEfforts,
    renamedEffort: renamed, effortIds: ids(efforts),
  };
}

/** 최근 30일 합치기 기록 — 되돌릴 수 있는지(undoable)와 이미 되돌렸는지(undone)를 함께 돌려준다. */
export async function listMergeHistory() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const logs = await prisma.auditLog.findMany({ where: { targetType: 'client_merge', createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 30 });
  const undone = await prisma.auditLog.findMany({ where: { targetType: 'client_merge_undo', createdAt: { gte: since } }, select: { targetId: true } });
  const doneSet = new Set(undone.map((u) => u.targetId));
  return logs.map((l) => {
    const a: any = l.afterValue;
    const b: any = l.beforeValue;
    return {
      auditId: l.id, createdAt: l.createdAt, keepName: a?.keep?.name ?? '',
      removed: (b?.removed ?? []).map((x: any) => x.name),
      undoable: !!a?.undo?.removed?.length, undone: doneSet.has(l.id),
    };
  });
}

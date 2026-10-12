import { z } from 'zod';
import { prisma } from '../../common/prisma';
import { normalizeContactInput } from './field-rules';

/**
 * 2026-10-11: 고객사 담당자(고객사 쪽에서 만난/요청한 사람) 저장·불러오기.
 * - 엔지니어가 고객사작업/미팅에 담당자를 입력하면 (고객사, 이름) 단위로 DB에 저장하고,
 *   다음에 같은 고객사를 고르면 가장 최근에 쓴 담당자를 자동으로 불러온다.
 * - 같은 이름은 한 사람으로 본다(전화번호만 갱신).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createContactSchema = z.object({
  name: z.string().min(1).max(80),
  phone: z.string().max(40).optional(),
});

export interface ContactSnapshot {
  contactId: string | null;
  contactName: string;
  contactPhone: string | null;
}

/**
 * 상태등록 요청에 담긴 담당자 정보를 확정한다.
 *  1) contactId가 오면 DB에서 확인(없거나 다른 고객사 것이면 이름으로 대체) 후 사용 기록(lastUsedAt)을 갱신.
 *  2) 이름만 오면 등록된 고객사 아래에 저장(이미 있으면 재사용)한다. 고객사를 특정할 수 없으면(미등록 이름)
 *     DB 목록에는 넣지 않고 이 기록에만 남긴다.
 * 실패해도 상태등록 자체를 막지 않도록 호출하는 쪽에서 try/catch로 감싼다.
 */
export async function resolveContactForEffort(p: {
  userId: string;
  clientId?: string | null;
  clientName?: string | null;
  contactId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
}): Promise<ContactSnapshot | null> {
  let clientId: string | null = p.clientId && UUID_RE.test(p.clientId) ? p.clientId : null;
  if (!clientId && p.clientName && p.clientName.trim()) {
    const found = await prisma.client.findFirst({ where: { name: { equals: p.clientName.trim(), mode: 'insensitive' } }, select: { id: true } });
    clientId = found?.id ?? null;
  }

  if (p.contactId && UUID_RE.test(p.contactId)) {
    const existing = await prisma.clientContact.findUnique({ where: { id: p.contactId } });
    if (existing && existing.isActive && (!clientId || existing.clientId === clientId)) {
      await prisma.clientContact.update({ where: { id: existing.id }, data: { lastUsedAt: new Date(), useCount: { increment: 1 } } });
      return { contactId: existing.id, contactName: existing.name, contactPhone: existing.phone ?? null };
    }
  }

  const normalized = normalizeContactInput({ name: p.contactName, phone: p.contactPhone });
  if (!normalized) return null;
  if (!clientId) return { contactId: null, contactName: normalized.name, contactPhone: normalized.phone };

  const saved = await prisma.clientContact.upsert({
    where: { clientId_name: { clientId, name: normalized.name } },
    create: { clientId, name: normalized.name, phone: normalized.phone, createdBy: p.userId, lastUsedAt: new Date(), useCount: 1 },
    update: { isActive: true, lastUsedAt: new Date(), useCount: { increment: 1 }, ...(normalized.phone ? { phone: normalized.phone } : {}) },
  });
  return { contactId: saved.id, contactName: saved.name, contactPhone: saved.phone ?? null };
}

/** 고객사별 담당자 목록/등록 라우트를 attendance 라우터에 붙인다(로그인 필요는 라우터가 이미 걸어둠). */
export function registerClientContactRoutes(router: any) {
  router.get('/clients/:clientId/contacts', async (req: any, res: any) => {
    const clientId = String(req.params.clientId || '');
    if (!UUID_RE.test(clientId)) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '고객사를 찾을 수 없습니다.' } });
    const rows = await prisma.clientContact.findMany({
      where: { clientId, isActive: true },
      orderBy: [{ lastUsedAt: { sort: 'desc', nulls: 'last' } }, { useCount: 'desc' }, { name: 'asc' }],
      take: 30,
      select: { id: true, name: true, phone: true, department: true, lastUsedAt: true },
    });
    return res.json({ success: true, data: rows });
  });

  router.post('/clients/:clientId/contacts', async (req: any, res: any) => {
    const clientId = String(req.params.clientId || '');
    if (!UUID_RE.test(clientId)) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '고객사를 찾을 수 없습니다.' } });
    const parsed = createContactSchema.safeParse(req.body);
    const normalized = parsed.success ? normalizeContactInput(parsed.data) : null;
    if (!normalized) return res.status(400).json({ success: false, error: { code: 'INVALID_INPUT', message: '담당자 이름을 입력하세요.' } });
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
    if (!client) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: '고객사를 찾을 수 없습니다.' } });
    const saved = await prisma.clientContact.upsert({
      where: { clientId_name: { clientId, name: normalized.name } },
      create: { clientId, name: normalized.name, phone: normalized.phone, createdBy: req.authUser!.userId, lastUsedAt: new Date(), useCount: 0 },
      update: { isActive: true, ...(normalized.phone ? { phone: normalized.phone } : {}) },
      select: { id: true, name: true, phone: true, department: true, lastUsedAt: true },
    });
    return res.json({ success: true, data: saved });
  });
}

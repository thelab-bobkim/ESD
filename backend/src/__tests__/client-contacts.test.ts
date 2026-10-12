// DB 없이 prisma를 가짜로 바꿔 고객사 담당자 저장/불러오기 규칙을 검증한다.
const mockPrisma: any = {
  client: { findFirst: jest.fn(), findUnique: jest.fn() },
  clientContact: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), upsert: jest.fn() },
};
jest.mock('../common/prisma', () => ({ prisma: mockPrisma }));

import { resolveContactForEffort, registerClientContactRoutes } from '../modules/attendance/client-contacts';

const CID = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const KID = '22222222-2222-4222-8222-222222222222';

function routes() {
  const h: Record<string, Function> = {};
  const reg = (m: string) => (path: string, ...fns: Function[]) => { h[`${m} ${path}`] = fns[fns.length - 1]; };
  registerClientContactRoutes({ get: reg('GET'), post: reg('POST') });
  return h;
}
function res() {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (b: any) => { r.body = b; return r; };
  return r;
}

beforeEach(() => { jest.clearAllMocks(); });

describe('resolveContactForEffort', () => {
  it('이름만 오면 등록된 고객사 아래에 upsert 하고 사용 기록을 남긴다', async () => {
    mockPrisma.clientContact.upsert.mockResolvedValue({ id: KID, name: '김대리', phone: '010-1' });
    const r = await resolveContactForEffort({ userId: 'u1', clientId: CID, contactName: ' 김대리 ', contactPhone: '010-1' });
    expect(r).toEqual({ contactId: KID, contactName: '김대리', contactPhone: '010-1' });
    const arg = mockPrisma.clientContact.upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ clientId_name: { clientId: CID, name: '김대리' } });
    expect(arg.create.createdBy).toBe('u1');
  });
  it('고객사 id가 없으면 이름으로 찾고, 못 찾으면 DB 목록엔 넣지 않고 기록에만 남긴다', async () => {
    mockPrisma.client.findFirst.mockResolvedValue(null);
    const r = await resolveContactForEffort({ userId: 'u1', clientName: '미등록사', contactName: '이부장' });
    expect(r).toEqual({ contactId: null, contactName: '이부장', contactPhone: null });
    expect(mockPrisma.clientContact.upsert).not.toHaveBeenCalled();
  });
  it('contactId가 같은 고객사의 담당자면 그대로 쓰고 lastUsedAt을 갱신', async () => {
    mockPrisma.clientContact.findUnique.mockResolvedValue({ id: KID, clientId: CID, name: '김대리', phone: null, isActive: true });
    const r = await resolveContactForEffort({ userId: 'u1', clientId: CID, contactId: KID });
    expect(r).toEqual({ contactId: KID, contactName: '김대리', contactPhone: null });
    expect(mockPrisma.clientContact.update).toHaveBeenCalledTimes(1);
  });
  it('다른 고객사의 담당자 id는 쓰지 않고 이름이 있으면 이름으로 대체', async () => {
    mockPrisma.clientContact.findUnique.mockResolvedValue({ id: KID, clientId: OTHER, name: '타사담당', isActive: true });
    mockPrisma.clientContact.upsert.mockResolvedValue({ id: 'new', name: '박과장', phone: null });
    const r = await resolveContactForEffort({ userId: 'u1', clientId: CID, contactId: KID, contactName: '박과장' });
    expect(r?.contactName).toBe('박과장');
    expect(mockPrisma.clientContact.update).not.toHaveBeenCalled();
  });
  it('이름도 id도 없으면 null', async () => {
    expect(await resolveContactForEffort({ userId: 'u1', clientId: CID })).toBeNull();
  });
});

describe('contacts routes', () => {
  it('GET: UUID가 아니면 404, 맞으면 최근 사용순 목록', async () => {
    const h = routes()['GET /clients/:clientId/contacts'];
    let r = res(); await h({ params: { clientId: 'x' } }, r); expect(r.statusCode).toBe(404);
    mockPrisma.clientContact.findMany.mockResolvedValue([{ id: KID, name: '김대리' }]);
    r = res(); await h({ params: { clientId: CID } }, r);
    expect(r.body.data).toHaveLength(1);
    expect(mockPrisma.clientContact.findMany.mock.calls[0][0].where).toEqual({ clientId: CID, isActive: true });
  });
  it('POST: 이름 없으면 400, 없는 고객사면 404, 정상이면 저장', async () => {
    const h = routes()['POST /clients/:clientId/contacts'];
    const rq = (body: any) => ({ params: { clientId: CID }, body, authUser: { userId: 'u1' } });
    let r = res(); await h(rq({ name: '  ' }), r); expect(r.statusCode).toBe(400);
    mockPrisma.client.findUnique.mockResolvedValue(null);
    r = res(); await h(rq({ name: '김대리' }), r); expect(r.statusCode).toBe(404);
    mockPrisma.client.findUnique.mockResolvedValue({ id: CID });
    mockPrisma.clientContact.upsert.mockResolvedValue({ id: KID, name: '김대리', phone: null });
    r = res(); await h(rq({ name: '김대리' }), r); expect(r.body.success).toBe(true);
  });
});

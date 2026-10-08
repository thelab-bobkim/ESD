// DB 없이 prisma를 가짜로 바꿔 "등록된 고객사일 때만 자동 연결·생성" 규칙(2026-10-08 사용자 결정)을 검증한다.
const mockPrisma: any = {
  client: { findUnique: jest.fn(), findMany: jest.fn() },
  project: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  projectMember: { upsert: jest.fn() },
};
jest.mock('../common/prisma', () => ({ prisma: mockPrisma }));

import { resolveAutoProject } from '../modules/projects/project-autolink';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.client.findUnique.mockResolvedValue(null);
  mockPrisma.client.findMany.mockResolvedValue([]);
  mockPrisma.project.findMany.mockResolvedValue([]);
  mockPrisma.project.findFirst.mockResolvedValue(null);
  mockPrisma.project.create.mockImplementation(async ({ data }: any) => ({ id: 'new-p', name: data.name }));
  mockPrisma.project.update.mockResolvedValue({});
  mockPrisma.projectMember.upsert.mockResolvedValue({});
});

const base = { userId: 'u1', clientName: '코스콤', allowCreate: true };

describe('resolveAutoProject', () => {
  it('등록되지 않은 고객사(자유입력)로는 프로젝트를 만들지 않는다', async () => {
    expect(await resolveAutoProject({ ...base, clientName: '이상한 자유입력 이름' })).toBeNull();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(mockPrisma.projectMember.upsert).not.toHaveBeenCalled();
  });

  it('등록 고객사인데 프로젝트가 없으면 새로 만들고 본인을 참여자로 넣는다', async () => {
    mockPrisma.client.findMany.mockResolvedValueOnce([{ id: 'c1', name: '코스콤' }]); // 이름 정확 일치
    const r = await resolveAutoProject(base);
    expect(r).toEqual({ id: 'new-p', name: '코스콤' });
    const data = mockPrisma.project.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ clientId: 'c1', status: 'ACTIVE', createdByUserId: 'u1', name: '코스콤' });
    expect(data.code).toBe('DSTI-0001');
    expect(mockPrisma.projectMember.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { projectId: 'new-p', userId: 'u1', role: 'MEMBER' } }));
  });

  it('이미 진행 중인 프로젝트가 있으면 새로 만들지 않고 그 프로젝트에 연결한다(본인 참여 프로젝트 우선)', async () => {
    mockPrisma.client.findUnique.mockResolvedValue({ id: 'c1', name: '코스콤' });
    mockPrisma.project.findMany.mockResolvedValue([
      { id: 'p-other', name: '코스콤 B', members: [], managerId: null },
      { id: 'p-mine', name: '코스콤 A', members: [{ id: 'm' }], managerId: null },
    ]);
    const r = await resolveAutoProject({ ...base, clientId: 'c1' });
    expect(r?.id).toBe('p-mine');
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
  });

  it('완료된 프로젝트만 있으면 새로 만들지 않고 다시 진행 상태로 되돌린다', async () => {
    mockPrisma.client.findUnique.mockResolvedValue({ id: 'c1', name: '코스콤' });
    mockPrisma.project.findFirst.mockResolvedValue({ id: 'p-done', name: '코스콤', managerId: null });
    const r = await resolveAutoProject({ ...base, clientId: 'c1' });
    expect(r?.id).toBe('p-done');
    expect(mockPrisma.project.update).toHaveBeenCalledWith({ where: { id: 'p-done' }, data: { status: 'ACTIVE', endDate: null } });
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
  });

  it('고객사미팅(allowCreate=false)은 기존 프로젝트에만 연결하고 새로 만들지 않는다', async () => {
    mockPrisma.client.findUnique.mockResolvedValue({ id: 'c1', name: '코스콤' });
    expect(await resolveAutoProject({ ...base, clientId: 'c1', allowCreate: false })).toBeNull();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
    expect(mockPrisma.project.update).not.toHaveBeenCalled();
  });

  it('같은 이름의 고객사(지점)가 여러 곳이면 특정할 수 없어 연결하지 않는다', async () => {
    mockPrisma.client.findMany.mockResolvedValueOnce([{ id: 'c1', name: '코스콤' }, { id: 'c2', name: '코스콤' }]);
    expect(await resolveAutoProject(base)).toBeNull();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
  });

  it('내부업무/SAMPLE 고객사 이름으로는 만들지 않는다', async () => {
    mockPrisma.client.findUnique.mockResolvedValue({ id: 'c9', name: '본사' });
    expect(await resolveAutoProject({ ...base, clientId: 'c9', clientName: '본사' })).toBeNull();
    mockPrisma.client.findUnique.mockResolvedValue({ id: 'c8', name: 'SAMPLE_고객사' });
    expect(await resolveAutoProject({ ...base, clientId: 'c8', clientName: 'SAMPLE_고객사' })).toBeNull();
    expect(mockPrisma.project.create).not.toHaveBeenCalled();
  });

  it('표기만 다른 이름("(주)코스콤")도 정규화로 같은 등록 고객사에 매칭한다', async () => {
    mockPrisma.client.findMany
      .mockResolvedValueOnce([]) // 정확 일치 없음
      .mockResolvedValueOnce([{ id: 'c1', name: '코스콤' }, { id: 'c2', name: '다른고객' }]); // 전체 목록
    const r = await resolveAutoProject({ ...base, clientName: '(주)코스콤' });
    expect(r?.id).toBe('new-p');
    expect(mockPrisma.project.create.mock.calls[0][0].data.clientId).toBe('c1');
  });

  it('프로젝트 코드가 동시에 충돌(P2002)하면 다시 시도한다', async () => {
    mockPrisma.client.findUnique.mockResolvedValue({ id: 'c1', name: '코스콤' });
    mockPrisma.project.create
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
      .mockImplementationOnce(async ({ data }: any) => ({ id: 'p2', name: data.name }));
    const r = await resolveAutoProject({ ...base, clientId: 'c1' });
    expect(r?.id).toBe('p2');
    expect(mockPrisma.project.create).toHaveBeenCalledTimes(2);
  });

  it('DB 오류가 나도 예외를 던지지 않고 null을 돌려준다(공수 등록 자체는 막지 않음)', async () => {
    mockPrisma.client.findUnique.mockRejectedValue(new Error('db down'));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveAutoProject({ ...base, clientId: 'c1' })).toBeNull();
    spy.mockRestore();
  });
});

import { PrismaClient } from '@prisma/client';

// 애플리케이션 전역에서 하나의 PrismaClient 인스턴스를 재사용한다.
export const prisma = new PrismaClient();

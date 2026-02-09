import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const adapter = new PrismaPg({
      connectionString: process.env.DATABASE_URL!,
    });
    super({ adapter } as any);
  }

  async onModuleInit() {
    await this.$connect();
    console.log('🚀 Prisma connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    console.log('🚀 Prisma disconnected from database');
  }
}

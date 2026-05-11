import { PrismaClient } from './src/generated/prisma/client/index.js';
const prisma = new PrismaClient();
prisma.organization.findMany().then(console.log).finally(() => prisma.$disconnect());

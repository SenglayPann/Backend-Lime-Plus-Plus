const { PrismaClient } = require('../src/generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function grantAdmin() {
  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { name: { contains: 'Senglay' } },
          { githubUsername: { contains: 'Senglay' } }
        ]
      }
    });

    if (!user) {
      console.log('User not found!');
      return;
    }

    const org = await prisma.organization.findFirst();
    
    await prisma.userRole.create({
      data: {
        userId: user.id,
        role: 'ADMIN',
        organizationId: org ? org.id : null
      }
    });

    console.log(`Successfully granted ADMIN role to ${user.name}`);
  } catch (e) {
    console.error('ERROR:', e);
  } finally {
    await prisma.$disconnect();
  }
}

grantAdmin();

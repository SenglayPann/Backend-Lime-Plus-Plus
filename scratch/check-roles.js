const { PrismaClient } = require('../src/generated/prisma');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function check() {
  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { name: { contains: 'Senglay' } },
          { githubUsername: { contains: 'Senglay' } }
        ]
      },
      include: {
        userRoles: true
      }
    });
    console.log('USER_DETAILS:', JSON.stringify(user, null, 2));
    
    const allRoles = await prisma.userRole.findMany({
      include: { user: true }
    });
    console.log('ALL_ROLES:', JSON.stringify(allRoles, null, 2));
    
  } catch (e) {
    console.error('ERROR:', e);
  } finally {
    await prisma.$disconnect();
  }
}

check();

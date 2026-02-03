import 'dotenv/config';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Starting seed...');

  // Clean existing data (in reverse order of dependencies)
  await prisma.webhookDelivery.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.scoreOverride.deleteMany();
  await prisma.contributionScore.deleteMany();
  await prisma.contributionEvent.deleteMany();
  await prisma.prReview.deleteMany();
  await prisma.pullRequest.deleteMany();
  await prisma.task.deleteMany();
  await prisma.projectMember.deleteMany();
  await prisma.project.deleteMany();
  await prisma.userRole.deleteMany();
  await prisma.user.deleteMany();
  await prisma.department.deleteMany();
  await prisma.organization.deleteMany();

  console.log('✅ Cleaned existing data');

  // Create Organizations
  const universityOrg = await prisma.organization.create({
    data: {
      name: 'Demo University',
      licensePlan: 'enterprise',
    },
  });

  const bootcampOrg = await prisma.organization.create({
    data: {
      name: 'Code Bootcamp',
      licensePlan: 'professional',
    },
  });

  console.log('✅ Created organizations');

  // Create Departments
  const csDept = await prisma.department.create({
    data: {
      name: 'Computer Science',
      organizationId: universityOrg.id,
    },
  });

  const engDept = await prisma.department.create({
    data: {
      name: 'Software Engineering',
      organizationId: universityOrg.id,
    },
  });

  const webDevDept = await prisma.department.create({
    data: {
      name: 'Full-Stack Development',
      organizationId: bootcampOrg.id,
    },
  });

  console.log('✅ Created departments');

  // Create Users
  const adminUser = await prisma.user.create({
    data: {
      githubUserId: 'admin-github-12345',
      email: 'admin@demo-university.edu',
      name: 'Dr. Sarah Admin',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
    },
  });

  const profUser = await prisma.user.create({
    data: {
      githubUserId: 'prof-github-67890',
      email: 'prof.johnson@demo-university.edu',
      name: 'Prof. Michael Johnson',
      avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4',
    },
  });

  const managerUser = await prisma.user.create({
    data: {
      githubUserId: 'manager-github-11111',
      email: 'manager@demo-university.edu',
      name: 'Emily Manager',
      avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
    },
  });

  const student1 = await prisma.user.create({
    data: {
      githubUserId: 'student1-github-22222',
      email: 'alice@student.demo-university.edu',
      name: 'Alice Chen',
      avatarUrl: 'https://avatars.githubusercontent.com/u/4?v=4',
    },
  });

  const student2 = await prisma.user.create({
    data: {
      githubUserId: 'student2-github-33333',
      email: 'bob@student.demo-university.edu',
      name: 'Bob Williams',
      avatarUrl: 'https://avatars.githubusercontent.com/u/5?v=4',
    },
  });

  const student3 = await prisma.user.create({
    data: {
      githubUserId: 'student3-github-44444',
      email: 'charlie@student.demo-university.edu',
      name: 'Charlie Davis',
      avatarUrl: 'https://avatars.githubusercontent.com/u/6?v=4',
    },
  });

  const student4 = await prisma.user.create({
    data: {
      githubUserId: 'student4-github-55555',
      email: 'diana@student.demo-university.edu',
      name: 'Diana Martinez',
      avatarUrl: 'https://avatars.githubusercontent.com/u/7?v=4',
    },
  });

  console.log('✅ Created users');

  // Create User Roles
  await prisma.userRole.createMany({
    data: [
      // Organization Owner
      {
        userId: adminUser.id,
        role: 'ORGANIZATION_OWNER',
        organizationId: universityOrg.id,
      },
      // Admin
      {
        userId: adminUser.id,
        role: 'ADMIN',
        organizationId: universityOrg.id,
      },
      // Department Manager
      {
        userId: profUser.id,
        role: 'DEPARTMENT_MANAGER',
        departmentId: csDept.id,
      },
      // Project Manager
      {
        userId: managerUser.id,
        role: 'PROJECT_MANAGER',
        departmentId: csDept.id,
      },
    ],
  });

  console.log('✅ Created user roles');

  // Create Projects
  const project1 = await prisma.project.create({
    data: {
      name: 'CS401 - Web Application Project',
      departmentId: csDept.id,
      platform: 'GITHUB',
      repository: 'demo-university/cs401-webapp',
      status: 'ACTIVE',
      evalStart: new Date('2026-01-15'),
      evalEnd: new Date('2026-05-15'),
    },
  });

  const project2 = await prisma.project.create({
    data: {
      name: 'CS402 - Mobile App Development',
      departmentId: csDept.id,
      platform: 'GITHUB',
      repository: 'demo-university/cs402-mobile',
      status: 'ACTIVE',
      evalStart: new Date('2026-02-01'),
      evalEnd: new Date('2026-06-01'),
    },
  });

  console.log('✅ Created projects');

  // Add Project Members
  await prisma.projectMember.createMany({
    data: [
      // Project 1 members
      { projectId: project1.id, userId: managerUser.id, role: 'PROJECT_MANAGER' },
      { projectId: project1.id, userId: student1.id, role: 'PROJECT_MEMBER' },
      { projectId: project1.id, userId: student2.id, role: 'PROJECT_MEMBER' },
      { projectId: project1.id, userId: student3.id, role: 'PROJECT_MEMBER' },
      // Project 2 members
      { projectId: project2.id, userId: managerUser.id, role: 'PROJECT_MANAGER' },
      { projectId: project2.id, userId: student2.id, role: 'PROJECT_MEMBER' },
      { projectId: project2.id, userId: student4.id, role: 'PROJECT_MEMBER' },
    ],
  });

  console.log('✅ Created project members');

  // Create Tasks for Project 1
  await prisma.task.createMany({
    data: [
      {
        projectId: project1.id,
        externalTaskId: 'TASK-001',
        title: 'Setup project repository and CI/CD',
        description: 'Initialize the repository with proper structure and configure GitHub Actions',
        assigneeId: student1.id,
        status: 'DONE',
        difficulty: 'MEDIUM',
        dueDate: new Date('2026-01-30'),
        completedAt: new Date('2026-01-28'),
      },
      {
        projectId: project1.id,
        externalTaskId: 'TASK-002',
        title: 'Design database schema',
        description: 'Create ERD and Prisma schema for the application',
        assigneeId: student2.id,
        status: 'DONE',
        difficulty: 'HIGH',
        dueDate: new Date('2026-02-05'),
        completedAt: new Date('2026-02-04'),
      },
      {
        projectId: project1.id,
        externalTaskId: 'TASK-003',
        title: 'Implement user authentication',
        description: 'Setup NextAuth with GitHub OAuth provider',
        assigneeId: student3.id,
        status: 'IN_PROGRESS',
        difficulty: 'HIGH',
        dueDate: new Date('2026-02-15'),
      },
      {
        projectId: project1.id,
        externalTaskId: 'TASK-004',
        title: 'Create dashboard UI components',
        description: 'Build reusable components for the main dashboard',
        assigneeId: student1.id,
        status: 'TODO',
        difficulty: 'MEDIUM',
        dueDate: new Date('2026-02-20'),
      },
      {
        projectId: project1.id,
        externalTaskId: 'TASK-005',
        title: 'API endpoint implementation',
        description: 'Implement REST endpoints for CRUD operations',
        assigneeId: student2.id,
        status: 'TODO',
        difficulty: 'HIGH',
        dueDate: new Date('2026-02-28'),
      },
    ],
  });

  console.log('✅ Created tasks');

  // Get tasks for creating PRs
  const tasks = await prisma.task.findMany({
    where: { projectId: project1.id },
    orderBy: { externalTaskId: 'asc' },
  });

  // Create Pull Requests
  await prisma.pullRequest.createMany({
    data: [
      {
        projectId: project1.id,
        platform: 'GITHUB',
        externalPrId: 'PR-1',
        taskId: tasks[0].id,
        authorId: student1.id,
        title: '[TASK-001] Setup project repository and CI/CD',
        url: 'https://github.com/demo-university/cs401-webapp/pull/1',
        status: 'MERGED',
        mergedAt: new Date('2026-01-28'),
      },
      {
        projectId: project1.id,
        platform: 'GITHUB',
        externalPrId: 'PR-2',
        taskId: tasks[1].id,
        authorId: student2.id,
        title: '[TASK-002] Design database schema',
        url: 'https://github.com/demo-university/cs401-webapp/pull/2',
        status: 'MERGED',
        mergedAt: new Date('2026-02-04'),
      },
      {
        projectId: project1.id,
        platform: 'GITHUB',
        externalPrId: 'PR-3',
        taskId: tasks[2].id,
        authorId: student3.id,
        title: '[TASK-003] Implement user authentication - WIP',
        url: 'https://github.com/demo-university/cs401-webapp/pull/3',
        status: 'OPEN',
      },
    ],
  });

  console.log('✅ Created pull requests');

  // Get PRs for creating reviews
  const pullRequests = await prisma.pullRequest.findMany({
    where: { projectId: project1.id },
    orderBy: { externalPrId: 'asc' },
  });

  // Create PR Reviews
  await prisma.prReview.createMany({
    data: [
      {
        pullRequestId: pullRequests[0].id,
        reviewerId: student2.id,
        state: 'APPROVED',
        body: 'LGTM! Great setup.',
      },
      {
        pullRequestId: pullRequests[1].id,
        reviewerId: student1.id,
        state: 'APPROVED',
        body: 'Schema looks good. Nice work on the relations.',
      },
      {
        pullRequestId: pullRequests[1].id,
        reviewerId: student3.id,
        state: 'APPROVED',
        body: 'Approved after suggested changes.',
      },
      {
        pullRequestId: pullRequests[2].id,
        reviewerId: student1.id,
        state: 'CHANGES_REQUESTED',
        body: 'Please add error handling for the OAuth callback.',
      },
    ],
  });

  console.log('✅ Created PR reviews');

  // Create Contribution Events
  await prisma.contributionEvent.createMany({
    data: [
      {
        projectId: project1.id,
        userId: student1.id,
        type: 'PR_MERGED',
        referenceId: pullRequests[0].id,
        score: 10,
      },
      {
        projectId: project1.id,
        userId: student1.id,
        type: 'TASK_COMPLETED',
        referenceId: tasks[0].id,
        score: 5,
      },
      {
        projectId: project1.id,
        userId: student2.id,
        type: 'PR_MERGED',
        referenceId: pullRequests[1].id,
        score: 15, // Higher score due to HIGH difficulty
      },
      {
        projectId: project1.id,
        userId: student2.id,
        type: 'TASK_COMPLETED',
        referenceId: tasks[1].id,
        score: 5,
      },
      {
        projectId: project1.id,
        userId: student2.id,
        type: 'PR_REVIEW_APPROVED',
        referenceId: pullRequests[0].id,
        score: 3,
      },
      {
        projectId: project1.id,
        userId: student1.id,
        type: 'PR_REVIEW_APPROVED',
        referenceId: pullRequests[1].id,
        score: 3,
      },
      {
        projectId: project1.id,
        userId: student3.id,
        type: 'PR_REVIEW_APPROVED',
        referenceId: pullRequests[1].id,
        score: 3,
      },
    ],
  });

  console.log('✅ Created contribution events');

  // Create Contribution Scores
  await prisma.contributionScore.createMany({
    data: [
      {
        projectId: project1.id,
        userId: student1.id,
        totalScore: 18,
        breakdown: {
          prMerged: 10,
          taskCompleted: 5,
          prReviewApproved: 3,
        },
      },
      {
        projectId: project1.id,
        userId: student2.id,
        totalScore: 23,
        breakdown: {
          prMerged: 15,
          taskCompleted: 5,
          prReviewApproved: 3,
        },
      },
      {
        projectId: project1.id,
        userId: student3.id,
        totalScore: 3,
        breakdown: {
          prMerged: 0,
          taskCompleted: 0,
          prReviewApproved: 3,
        },
      },
    ],
  });

  console.log('✅ Created contribution scores');

  console.log('');
  console.log('🎉 Seed completed successfully!');
  console.log('');
  console.log('📊 Summary:');
  console.log(`   Organizations: 2`);
  console.log(`   Departments: 3`);
  console.log(`   Users: 7`);
  console.log(`   Projects: 2`);
  console.log(`   Tasks: 5`);
  console.log(`   Pull Requests: 3`);
  console.log(`   PR Reviews: 4`);
  console.log(`   Contribution Events: 7`);
  console.log(`   Contribution Scores: 3`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('❌ Seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });

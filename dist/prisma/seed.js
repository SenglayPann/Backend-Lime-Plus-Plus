"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function main() {
    console.log('🌱 Seeding database...');
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
    console.log('✓ Cleaned existing data');
    const org = await prisma.organization.create({
        data: {
            name: 'Engineering Faculty',
            licensePlan: 'enterprise',
        },
    });
    console.log(`✓ Created organization: ${org.name}`);
    const csDept = await prisma.department.create({
        data: {
            name: 'Computer Science',
            organizationId: org.id,
        },
    });
    const seDept = await prisma.department.create({
        data: {
            name: 'Software Engineering',
            organizationId: org.id,
        },
    });
    console.log(`✓ Created ${2} departments`);
    const teacher = await prisma.user.create({
        data: {
            githubUserId: 'teacher-001',
            email: 'teacher@university.edu',
            name: 'Dr. Jane Smith',
            avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
        },
    });
    const student1 = await prisma.user.create({
        data: {
            githubUserId: 'student-001',
            email: 'alice@student.edu',
            name: 'Alice Johnson',
            avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4',
        },
    });
    const student2 = await prisma.user.create({
        data: {
            githubUserId: 'student-002',
            email: 'bob@student.edu',
            name: 'Bob Williams',
            avatarUrl: 'https://avatars.githubusercontent.com/u/3?v=4',
        },
    });
    const student3 = await prisma.user.create({
        data: {
            githubUserId: 'student-003',
            email: 'charlie@student.edu',
            name: 'Charlie Brown',
            avatarUrl: 'https://avatars.githubusercontent.com/u/4?v=4',
        },
    });
    console.log(`✓ Created ${4} users`);
    await prisma.userRole.createMany({
        data: [
            {
                userId: teacher.id,
                role: client_1.Role.DEPARTMENT_MANAGER,
                organizationId: org.id,
                departmentId: csDept.id,
            },
            {
                userId: student1.id,
                role: client_1.Role.PROJECT_MEMBER,
                organizationId: org.id,
            },
            {
                userId: student2.id,
                role: client_1.Role.PROJECT_MEMBER,
                organizationId: org.id,
            },
            {
                userId: student3.id,
                role: client_1.Role.PROJECT_MANAGER,
                organizationId: org.id,
            },
        ],
    });
    console.log(`✓ Assigned roles`);
    const project = await prisma.project.create({
        data: {
            name: 'Distributed Systems Project',
            departmentId: csDept.id,
            platform: client_1.Platform.GITHUB,
            repository: 'university/distributed-systems-2026',
            externalProjectId: 'PVT_kwHOAABCD',
            status: client_1.ProjectStatus.ACTIVE,
            evalStart: new Date('2026-03-01'),
            evalEnd: new Date('2026-05-30'),
        },
    });
    console.log(`✓ Created project: ${project.name}`);
    await prisma.projectMember.createMany({
        data: [
            { projectId: project.id, userId: student1.id, role: client_1.Role.PROJECT_MEMBER },
            { projectId: project.id, userId: student2.id, role: client_1.Role.PROJECT_MEMBER },
            { projectId: project.id, userId: student3.id, role: client_1.Role.PROJECT_MANAGER },
        ],
    });
    console.log(`✓ Added ${3} project members`);
    const task1 = await prisma.task.create({
        data: {
            projectId: project.id,
            externalTaskId: 'TASK-1',
            title: 'Implement JWT Authentication',
            description: 'Set up JWT-based authentication for the API',
            assigneeId: student1.id,
            status: client_1.TaskStatus.DONE,
            difficulty: client_1.TaskDifficulty.MEDIUM,
            completedAt: new Date('2026-03-15'),
        },
    });
    const task2 = await prisma.task.create({
        data: {
            projectId: project.id,
            externalTaskId: 'TASK-2',
            title: 'Create Database Schema',
            description: 'Design and implement the PostgreSQL schema',
            assigneeId: student2.id,
            status: client_1.TaskStatus.IN_PROGRESS,
            difficulty: client_1.TaskDifficulty.HIGH,
        },
    });
    const task3 = await prisma.task.create({
        data: {
            projectId: project.id,
            externalTaskId: 'TASK-3',
            title: 'Build REST API endpoints',
            description: 'Implement CRUD operations for all resources',
            assigneeId: student3.id,
            status: client_1.TaskStatus.TODO,
            difficulty: client_1.TaskDifficulty.HIGH,
        },
    });
    console.log(`✓ Created ${3} tasks`);
    const pr1 = await prisma.pullRequest.create({
        data: {
            projectId: project.id,
            platform: client_1.Platform.GITHUB,
            externalPrId: '1',
            taskId: task1.id,
            authorId: student1.id,
            title: '[TASK-1] Implement JWT Authentication',
            url: 'https://github.com/university/distributed-systems-2026/pull/1',
            status: 'MERGED',
            mergedAt: new Date('2026-03-15'),
        },
    });
    console.log(`✓ Created ${1} pull request`);
    await prisma.prReview.create({
        data: {
            pullRequestId: pr1.id,
            reviewerId: student2.id,
            state: 'APPROVED',
            body: 'LGTM! Great implementation.',
        },
    });
    console.log(`✓ Created ${1} PR review`);
    await prisma.contributionEvent.createMany({
        data: [
            {
                projectId: project.id,
                userId: student1.id,
                type: 'PR_MERGED',
                referenceId: pr1.id,
                score: 10,
            },
            {
                projectId: project.id,
                userId: student1.id,
                type: 'TASK_COMPLETED',
                referenceId: task1.id,
                score: 5,
            },
            {
                projectId: project.id,
                userId: student2.id,
                type: 'PR_REVIEW_APPROVED',
                referenceId: pr1.id,
                score: 3,
            },
        ],
    });
    console.log(`✓ Created ${3} contribution events`);
    await prisma.contributionScore.createMany({
        data: [
            {
                projectId: project.id,
                userId: student1.id,
                totalScore: 15,
                breakdown: {
                    PR_MERGED: [{ task: 'TASK-1', score: 10 }],
                    TASK_COMPLETED: [{ task: 'TASK-1', score: 5 }],
                },
            },
            {
                projectId: project.id,
                userId: student2.id,
                totalScore: 3,
                breakdown: {
                    REVIEWS: [{ pr: 'PR-1', score: 3 }],
                },
            },
            {
                projectId: project.id,
                userId: student3.id,
                totalScore: 0,
                breakdown: {},
            },
        ],
    });
    console.log(`✓ Created ${3} contribution scores`);
    console.log('\n🎉 Database seeded successfully!');
    console.log('\n📊 Summary:');
    console.log(`   - 1 Organization`);
    console.log(`   - 2 Departments`);
    console.log(`   - 4 Users (1 teacher, 3 students)`);
    console.log(`   - 1 Project`);
    console.log(`   - 3 Tasks`);
    console.log(`   - 1 Pull Request (merged)`);
    console.log(`   - 1 PR Review`);
    console.log(`   - Contribution scores calculated`);
}
main()
    .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
//# sourceMappingURL=seed.js.map
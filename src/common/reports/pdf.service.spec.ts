import { PdfService } from './pdf.service';

describe('PdfService', () => {
  const service = new PdfService();

  it('generates an openable project PDF buffer', async () => {
    const buffer = await service.generateProjectReport({
      project: {
        name: 'Distributed Systems',
        organization: 'Uni',
        department: 'CS',
        repository: 'org/repo',
        externalProjectId: 'PVT_1',
        status: 'LOCKED (FINAL)',
        evalStart: new Date('2026-03-01T00:00:00.000Z'),
        evalEnd: new Date('2026-05-30T00:00:00.000Z'),
        lockedAt: new Date('2026-05-31T00:00:00.000Z'),
        generatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
      leadership: { projectManagers: ['Teacher'] },
      summary: {
        totalMembers: 1,
        activeContributors: 1,
        totalTasks: 1,
        doneTasks: 1,
        mergedPrs: 1,
        averageDoneTasks: 1,
      },
      members: [
        {
          name: 'Student One',
          githubUsername: 'student1',
          projectRole: 'PROJECT_MEMBER',
          totalScore: 10,
          doneTasks: 1,
          mergedPrs: 1,
          approvedReviews: 0,
          overrideDelta: 0,
        },
      ],
      tasks: [
        {
          taskId: 'TASK-1',
          title: 'Implement feature',
          assignee: 'Student One',
          status: 'DONE',
          linkedPr: '123',
          prStatus: 'MERGED',
          mergedAt: new Date('2026-05-01T00:00:00.000Z'),
          score: 10,
        },
      ],
      overrides: [],
      auditLogs: [],
    });

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(buffer.toString('latin1')).toContain('%%EOF');
  });

  it('generates an openable individual PDF buffer', async () => {
    const buffer = await service.generateIndividualReport({
      student: {
        name: 'Student One',
        githubUsername: 'student1',
        email: 'student@example.com',
        projectRole: 'PROJECT_MEMBER',
      },
      project: {
        name: 'Distributed Systems',
        organization: 'Uni',
        department: 'CS',
        repository: 'org/repo',
        externalProjectId: 'PVT_1',
        status: 'ACTIVE',
        generatedAt: new Date('2026-06-01T00:00:00.000Z'),
      },
      score: {
        totalScore: 10,
        taskCompletionPoints: 10,
        reviewPoints: 0,
        overrideDelta: 0,
        lastUpdated: new Date('2026-05-01T00:00:00.000Z'),
      },
      contributionEvidence: [
        {
          taskId: 'TASK-1',
          title: 'Implement feature',
          prNumber: '123',
          prTitle: 'Add feature',
          status: 'MERGED',
          mergedAt: new Date('2026-05-01T00:00:00.000Z'),
          score: 10,
          url: 'https://github.com/org/repo/pull/123',
        },
      ],
      reviews: [],
      overrides: [],
      warnings: ['No report warnings detected'],
    });

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(buffer.toString('latin1')).toContain('%%EOF');
  });
});

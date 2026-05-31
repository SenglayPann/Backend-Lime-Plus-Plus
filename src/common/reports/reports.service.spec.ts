import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from './pdf.service';
import { ProjectAccessService } from '../access/project-access.service';
import { OrganizationAccessService } from '../access/organization-access.service';
import { DepartmentAccessService } from '../access/department-access.service';

describe('ReportsService', () => {
  let service: ReportsService;

  const mockPrismaService = {
    contributionScore: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    project: { findUnique: jest.fn(), findMany: jest.fn() },
    projectMember: { count: jest.fn() },
    organization: { findUnique: jest.fn() },
    department: { findUnique: jest.fn() },
    pullRequest: { findMany: jest.fn(), count: jest.fn() },
    prReview: { findMany: jest.fn() },
    task: { findMany: jest.fn(), count: jest.fn() },
    scoreOverride: { findMany: jest.fn(), count: jest.fn() },
    auditLog: { count: jest.fn() },
    generatedReport: {
      create: jest.fn().mockResolvedValue({
        id: 'report-id',
        generatedAt: new Date('2026-06-01T00:00:00Z'),
      }),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue('http://localhost:3000'),
  };

  const mockPdfService = {
    generateIndividualReport: jest.fn(),
    generateProjectReport: jest.fn(),
  };

  const mockProjectAccessService = {
    assertCanViewProject: jest.fn(),
    assertCanManageProject: jest.fn(),
  };
  const mockOrganizationAccessService = {
    assertCanManageOrganization: jest.fn(),
  };
  const mockDepartmentAccessService = {
    assertCanManageDepartment: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PdfService, useValue: mockPdfService },
        { provide: ProjectAccessService, useValue: mockProjectAccessService },
        {
          provide: OrganizationAccessService,
          useValue: mockOrganizationAccessService,
        },
        { provide: DepartmentAccessService, useValue: mockDepartmentAccessService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
    jest.clearAllMocks();
    mockPrismaService.projectMember.count.mockResolvedValue(0);
    mockPrismaService.task.count.mockResolvedValue(0);
    mockPrismaService.pullRequest.count.mockResolvedValue(0);
    mockPrismaService.contributionScore.findMany.mockResolvedValue([]);
    mockPrismaService.contributionScore.count.mockResolvedValue(0);
    mockPrismaService.scoreOverride.count.mockResolvedValue(0);
    mockPrismaService.auditLog.count.mockResolvedValue(0);
  });

  describe('exportIndividualPdf', () => {
    it('throws NotFoundException if score data is missing', async () => {
      mockPrismaService.contributionScore.findUnique.mockResolvedValue(null);

      await expect(
        service.exportIndividualPdf('p1', 'u1', 'u1', ['PROJECT_MEMBER']),
      ).rejects.toThrow(NotFoundException);
    });

    it('builds an evidence-rich individual report', async () => {
      mockPrismaService.contributionScore.findUnique.mockResolvedValue({
        totalScore: 100,
        updatedAt: new Date('2026-05-01T10:00:00.000Z'),
        breakdown: {
          TASK_COMPLETED: [{ task: 'TASK-1', score: 10 }],
          REVIEWS: [{ pr: '123', score: 3 }],
          OVERRIDES: [{ reason: 'Adjustment', score: 2 }],
        },
        user: {
          name: 'Test User',
          githubUsername: 'testuser',
          email: 'test@test.com',
        },
        project: {
          name: 'Distributed Systems',
          repository: 'org/repo',
          externalProjectId: 'PVT_1',
          status: 'ACTIVE',
          evalStart: null,
          evalEnd: null,
          lockedAt: null,
          members: [{ role: 'PROJECT_MANAGER' }],
          department: { name: 'CS', organization: { name: 'Uni' } },
        },
      });
      mockPrismaService.pullRequest.findMany.mockResolvedValue([
        {
          externalPrId: '123',
          taskId: 'task-db-1',
          title: 'Implement feature',
          status: 'MERGED',
          mergedAt: new Date('2026-05-02T10:00:00.000Z'),
          url: 'https://github.com/org/repo/pull/123',
          task: { externalTaskId: 'TASK-1', title: 'Task 1' },
        },
      ]);
      mockPrismaService.prReview.findMany.mockResolvedValue([
        {
          state: 'APPROVED',
          createdAt: new Date('2026-05-02T11:00:00.000Z'),
          pullRequest: { externalPrId: '124' },
        },
      ]);
      mockPrismaService.task.findMany.mockResolvedValue([]);
      mockPrismaService.scoreOverride.findMany.mockResolvedValue([
        {
          delta: 2,
          reason: 'Adjustment',
          createdAt: new Date('2026-05-03T10:00:00.000Z'),
          overrider: { name: 'Teacher', githubUsername: 'teacher' },
        },
      ]);
      mockPdfService.generateIndividualReport.mockResolvedValue(
        Buffer.from('%PDF-test'),
      );

      const result = await service.exportIndividualPdf('p1', 'u1', 'u1', [
        'PROJECT_MEMBER',
      ]);

      expect(result.toString()).toContain('%PDF');
      expect(mockPdfService.generateIndividualReport).toHaveBeenCalledWith(
        expect.objectContaining({
          student: expect.objectContaining({
            name: 'Test User',
            projectRole: 'PROJECT_MANAGER',
          }),
          score: expect.objectContaining({
            totalScore: 100,
            taskCompletionPoints: 10,
            reviewPoints: 3,
            overrideDelta: 2,
          }),
          contributionEvidence: [
            expect.objectContaining({
              taskId: 'TASK-1',
              prNumber: '123',
              score: 10,
            }),
          ],
        }),
      );
    });
  });

  describe('exportProjectPdf', () => {
    it('humanizes audit metadata without exposing raw internal IDs', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        id: 'p1',
        name: 'Capstone',
        repository: 'org/repo',
        externalProjectId: 'PVT_1',
        status: 'ACTIVE',
        evalStart: null,
        evalEnd: null,
        lockedAt: null,
        department: {
          name: 'Computer Science',
          organization: { name: 'Demo University' },
        },
        members: [],
        tasks: [],
        pullRequests: [],
        contributionScores: [],
        scoreOverrides: [],
        auditLogs: [
          {
            action: 'ROLE_CHANGE',
            actor: { name: 'Teacher', githubUsername: 'teacher' },
            createdAt: new Date('2026-05-04T10:00:00.000Z'),
            metadata: {
              operation: 'assign',
              targetUserId: 'user-db-id',
              role: 'PROJECT_MANAGER',
              organizationId: 'org-db-id',
            },
          },
        ],
      });
      mockPdfService.generateProjectReport.mockResolvedValue(
        Buffer.from('%PDF-project'),
      );

      await service.exportProjectPdf('p1', 'teacher', ['DEPARTMENT_MANAGER']);

      const reportData = mockPdfService.generateProjectReport.mock.calls[0][0];
      expect(reportData.auditLogs[0].metadata).toBe(
        'Assigned role PROJECT MANAGER; Scope: organization scope',
      );
      expect(reportData.auditLogs[0].metadata).not.toContain('user-db-id');
      expect(reportData.auditLogs[0].metadata).not.toContain('{');
    });
  });

  describe('exportProjectCsv', () => {
    it('generates an Excel-openable CSV with essential columns', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        members: [
          {
            userId: 'u1',
            role: 'PROJECT_MEMBER',
            user: {
              name: 'User 1',
              githubUsername: 'u1',
              email: 'u1@example.com',
            },
          },
        ],
        tasks: [{ assigneeId: 'u1', status: 'DONE' }],
        pullRequests: [
          {
            authorId: 'u1',
            status: 'MERGED',
            reviews: [{ reviewerId: 'u1', state: 'APPROVED' }],
          },
        ],
        contributionScores: [
          {
            userId: 'u1',
            totalScore: 100,
            updatedAt: new Date('2026-05-04T10:00:00.000Z'),
            breakdown: {},
            user: {
              id: 'u1',
              name: 'User 1',
              githubUsername: 'u1',
              email: 'u1@example.com',
            },
          },
        ],
        scoreOverrides: [{ userId: 'u1', delta: 5 }],
      });

      const csv = await service.exportProjectCsv('p1', 'teacher', [
        'DEPARTMENT_MANAGER',
      ]);

      expect(csv.charCodeAt(0)).toBe(0xfeff);
      expect(csv).toContain('"Rank","Student Name","GitHub Username"');
      expect(csv).toContain('"User 1","u1","u1@example.com"');
      expect(csv).toContain('100,1,1,1,5');
    });

    it('prefixes formula-like CSV values to avoid spreadsheet execution', async () => {
      mockPrismaService.project.findUnique.mockResolvedValue({
        members: [
          {
            userId: 'u1',
            role: 'PROJECT_MEMBER',
            user: {
              name: '=HYPERLINK("https://example.test")',
              githubUsername: '+attacker',
              email: ' user@example.com',
            },
          },
        ],
        tasks: [],
        pullRequests: [],
        contributionScores: [
          {
            userId: 'u1',
            totalScore: 10,
            updatedAt: new Date('2026-05-04T10:00:00.000Z'),
            breakdown: {},
            user: {
              id: 'u1',
              name: '=HYPERLINK("https://example.test")',
              githubUsername: '+attacker',
              email: ' user@example.com',
            },
          },
        ],
        scoreOverrides: [],
      });

      const csv = await service.exportProjectCsv('p1', 'teacher', [
        'DEPARTMENT_MANAGER',
      ]);

      expect(csv).toContain(`"'=HYPERLINK`);
      expect(csv).toContain(`"'+attacker"`);
      expect(csv).toContain(`" user@example.com"`);
    });

    it('rejects oversized project CSV exports before summary generation', async () => {
      mockPrismaService.projectMember.count.mockResolvedValueOnce(5001);

      await expect(
        service.exportProjectCsv('p1', 'teacher', ['DEPARTMENT_MANAGER']),
      ).rejects.toThrow(PayloadTooLargeException);
      expect(mockPrismaService.project.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('exportOrganizationCsv', () => {
    it('generates an organization CSV across scoped projects', async () => {
      mockPrismaService.organization.findUnique.mockResolvedValue({
        id: 'org-1',
        name: 'Demo University',
      });
      mockPrismaService.project.findMany.mockResolvedValue([
        {
          id: 'project-1',
          name: 'Capstone',
          status: 'ACTIVE',
          department: {
            name: 'Computer Science',
            organization: { name: 'Demo University' },
          },
          members: [
            {
              userId: 'u1',
              role: 'PROJECT_MEMBER',
              user: {
                name: 'User 1',
                githubUsername: 'u1',
                email: 'u1@example.com',
              },
            },
          ],
          tasks: [{ assigneeId: 'u1', status: 'DONE' }],
          pullRequests: [{ authorId: 'u1', status: 'MERGED', reviews: [] }],
          contributionScores: [
            {
              userId: 'u1',
              totalScore: 100,
              updatedAt: new Date('2026-05-04T10:00:00.000Z'),
              breakdown: {},
              user: {
                id: 'u1',
                name: 'User 1',
                githubUsername: 'u1',
                email: 'u1@example.com',
              },
            },
          ],
          scoreOverrides: [],
        },
      ]);

      const csv = await service.exportOrganizationCsv('org-1', 'admin', [
        'ADMIN',
      ]);

      expect(csv.charCodeAt(0)).toBe(0xfeff);
      expect(csv).toContain('"Scope Type","Scope ID","Scope Name"');
      expect(csv).toContain('"organization","org-1","Demo University"');
      expect(csv).toContain('"Capstone"');
      expect(csv).toContain('"User 1","u1","u1@example.com"');
    });
  });
});

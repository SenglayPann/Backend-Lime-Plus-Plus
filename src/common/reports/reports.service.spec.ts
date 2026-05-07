import { Test, TestingModule } from '@nestjs/testing';
import { ReportsService } from './reports.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from './pdf.service';
import { NotFoundException } from '@nestjs/common';

describe('ReportsService', () => {
  let service: ReportsService;

  const mockPrismaService = {
    contributionScore: { findUnique: jest.fn(), findMany: jest.fn() },
    project: { findUnique: jest.fn() },
    pullRequest: { findMany: jest.fn() },
  };

  const mockPdfService = {
    generateIndividualReport: jest.fn(),
    generateProjectReport: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PdfService, useValue: mockPdfService },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
    jest.clearAllMocks();
  });

  describe('exportIndividualPdf', () => {
    it('should throw NotFoundException if score data missing', async () => {
      mockPrismaService.contributionScore.findUnique.mockResolvedValue(null);
      await expect(service.exportIndividualPdf('p1', 'u1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should fetch authentic data and call PdfService', async () => {
      const mockScore = {
        totalScore: 100,
        breakdown: { PR_MERGED: [{ task: 'T1', score: 40 }] },
        user: {
          name: 'Test User',
          githubUsername: 'testuser',
          email: 'test@test.com',
        },
        project: {
          repository: 'org/repo',
          department: { name: 'CS', organization: { name: 'Uni' } },
        },
      };

      mockPrismaService.contributionScore.findUnique.mockResolvedValue(
        mockScore,
      );
      mockPrismaService.pullRequest.findMany.mockResolvedValue([
        {
          externalPrId: '123',
          status: 'MERGED',
          task: { externalTaskId: 'T1', title: 'Task 1' },
        },
      ]);
      mockPdfService.generateIndividualReport.mockResolvedValue(
        Buffer.from('pdf-content'),
      );

      const result = await service.exportIndividualPdf('p1', 'u1');

      expect(result).toBeInstanceOf(Buffer);
      expect(mockPdfService.generateIndividualReport).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test User',
          totalScore: 100,
          pullRequests: expect.arrayContaining([
            expect.objectContaining({ title: 'Task 1', score: 40 }) as unknown,
          ]) as unknown,
        }) as unknown,
      );
    });
  });

  describe('exportProjectCsv', () => {
    it('should generate valid CSV string', async () => {
      mockPrismaService.contributionScore.findMany.mockResolvedValue([
        {
          totalScore: 100,
          updatedAt: new Date(),
          user: { name: 'User 1', githubUsername: 'u1' },
        },
        {
          totalScore: 80,
          updatedAt: new Date(),
          user: { name: 'User 2', githubUsername: 'u2' },
        },
      ]);

      const csv = await service.exportProjectCsv('p1');
      expect(csv).toContain('"githubUsername","name","totalScore"');
      expect(csv).toContain('"u1","User 1",100');
      expect(csv).toContain('"u2","User 2",80');
    });
  });
});

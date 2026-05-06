import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from './pdf.service';
import { Parser } from 'json2csv';
import { ProjectStatus } from '../../generated/prisma';

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private pdfService: PdfService,
  ) {}

  async exportIndividualPdf(
    projectId: string,
    userId: string,
  ): Promise<Buffer> {
    const scoreInfo = await this.prisma.contributionScore.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: {
        user: true,
        project: {
          include: {
            department: {
              include: { organization: true },
            },
          },
        },
      },
    });

    if (!scoreInfo) throw new NotFoundException('Score data not found');

    // Fetch linked PRs as evidence
    const pullRequests = await this.prisma.pullRequest.findMany({
      where: {
        projectId,
        authorId: userId,
        status: 'MERGED',
      },
      include: { task: true },
    });

    const breakdownData = scoreInfo.breakdown as any;
    const reportData = {
      name: scoreInfo.user.name || scoreInfo.user.githubUsername,
      email: scoreInfo.user.email,
      organization: scoreInfo.project.department.organization.name,
      department: scoreInfo.project.department.name,
      totalScore: scoreInfo.totalScore,
      breakdown: [
        { name: 'PRs Merged', value: (breakdownData.PR_MERGED || []).length },
        {
          name: 'Tasks Completed',
          value: (breakdownData.TASK_COMPLETED || []).length,
        },
        {
          name: 'Reviews Approved',
          value: (breakdownData.REVIEWS || []).length,
        },
      ],
      pullRequests: pullRequests.map((pr) => ({
        id: pr.task?.externalTaskId || pr.externalPrId,
        title: pr.task?.title || 'Unknown Task',
        score:
          (breakdownData.PR_MERGED || []).find(
            (p: any) => p.task === pr.task?.externalTaskId,
          )?.score || 0,
        url: `https://github.com/${scoreInfo.project.repository}/pull/${pr.externalPrId}`,
      })),
    };

    return this.pdfService.generateIndividualReport(reportData);
  }

  async exportProjectPdf(projectId: string): Promise<Buffer> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        department: { include: { organization: true } },
        contributionScores: {
          include: { user: true },
          orderBy: { totalScore: 'desc' },
        },
      },
    });

    if (!project) throw new NotFoundException('Project not found');

    const reportData = {
      name: project.name,
      organization: project.department.organization.name,
      status:
        project.status === ProjectStatus.LOCKED ? 'LOCKED (FINAL)' : 'ACTIVE',
      members: project.contributionScores.map((cs) => ({
        name: cs.user.name || cs.user.githubUsername,
        score: cs.totalScore,
      })),
    };

    return this.pdfService.generateProjectReport(reportData);
  }

  async exportProjectCsv(projectId: string): Promise<string> {
    const scores = await this.prisma.contributionScore.findMany({
      where: { projectId },
      include: { user: true },
      orderBy: { totalScore: 'desc' },
    });

    const data = scores.map((s) => ({
      githubUsername: s.user.githubUsername,
      name: s.user.name,
      totalScore: s.totalScore,
      lastUpdated: s.updatedAt,
    }));

    const parser = new Parser();
    return parser.parse(data);
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PdfService } from './pdf.service';
import { Parser } from 'json2csv';

@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private pdfService: PdfService,
  ) {}

  async exportIndividualPdf(projectId: string, userId: string): Promise<Buffer> {
    const scoreInfo = await this.prisma.contributionScore.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { 
        user: true, 
        project: { 
          include: { 
            department: { 
              include: { organization: true } 
            } 
          } 
        } 
      },
    });
    
    if (!scoreInfo) throw new NotFoundException('Score data not found');

    const reportData = {
      name: scoreInfo.user.name || scoreInfo.user.githubUsername,
      email: scoreInfo.user.email,
      organization: scoreInfo.project.department.organization.name,
      department: scoreInfo.project.department.name,
      totalScore: scoreInfo.totalScore,
      breakdown: [
        { name: 'PRs Merged', value: scoreInfo.totalScore * 0.6 }, // Mocking distribution for PDF layout
        { name: 'Tasks Completed', value: scoreInfo.totalScore * 0.3 },
        { name: 'Other', value: scoreInfo.totalScore * 0.1 },
      ],
      pullRequests: [], // In real app, join with PullRequest table
    };

    return this.pdfService.generateIndividualReport(reportData);
  }

  async exportProjectPdf(projectId: string): Promise<Buffer> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { 
        department: { include: { organization: true } },
        contributionScores: { include: { user: true }, orderBy: { totalScore: 'desc' } }
      }
    });

    if (!project) throw new NotFoundException('Project not found');

    const reportData = {
      name: project.name,
      organization: project.department.organization.name,
      status: project.isLocked ? 'LOCKED (FINAL)' : 'ACTIVE',
      members: project.contributionScores.map(cs => ({
        name: cs.user.name || cs.user.githubUsername,
        score: cs.totalScore
      }))
    };

    return this.pdfService.generateProjectReport(reportData);
  }

  async exportProjectCsv(projectId: string): Promise<string> {
    const scores = await this.prisma.contributionScore.findMany({
      where: { projectId },
      include: { user: true },
      orderBy: { totalScore: 'desc' },
    });

    const data = scores.map(s => ({
      githubUsername: s.user.githubUsername,
      name: s.user.name,
      totalScore: s.totalScore,
      lastUpdated: s.updatedAt
    }));

    const parser = new Parser();
    return parser.parse(data);
  }
}

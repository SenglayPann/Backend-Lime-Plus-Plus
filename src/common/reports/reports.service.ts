import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  async generateIndividualReport(projectId: string, userId: string) {
    const scoreInfo = await this.prisma.contributionScore.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { user: true, project: true },
    });
    
    if (!scoreInfo) return null;

    // In a real project, we would use a library like `pdfmake` or `json2csv` here.
    // For MVP, we return the JSON data which the frontend can format.
    return {
      generatedAt: new Date(),
      type: 'INDIVIDUAL',
      data: scoreInfo,
    };
  }

  async generateProjectReport(projectId: string) {
    const scores = await this.prisma.contributionScore.findMany({
      where: { projectId },
      include: { user: true },
      orderBy: { totalScore: 'desc' },
    });

    return {
      generatedAt: new Date(),
      type: 'PROJECT_WIDE',
      projectId,
      data: scores,
    };
  }
}

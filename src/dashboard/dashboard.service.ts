import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getGlobalStats() {
    const studentsCount = await this.prisma.userRole.count({
      where: { role: 'PROJECT_MEMBER' },
    });

    const ongoingProjectsCount = await this.prisma.project.count({
      where: { status: 'ACTIVE' },
    });

    const prsCount = await this.prisma.pullRequest.count();

    const scores = await this.prisma.contributionScore.findMany({
      select: { totalScore: true },
    });

    const avgContribution = scores.length > 0 
      ? scores.reduce((sum, s) => sum + s.totalScore, 0) / scores.length 
      : 0;

    return {
      activeStudents: studentsCount,
      ongoingProjects: ongoingProjectsCount,
      pullRequests: prsCount,
      avgContribution: Number(avgContribution.toFixed(1)),
    };
  }

  async getRecentActivity() {
    const recentEvents = await this.prisma.contributionEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 5,
      include: {
        user: true,
        project: true,
      },
    });

    return recentEvents.map((event) => ({
      id: event.id,
      title: event.type.split('_').map(word => word.charAt(0) + word.slice(1).toLowerCase()).join(' '),
      projectId: event.project.id,
      projectName: event.project.name,
      authorName: event.user.name || event.user.githubUsername,
      score: event.score,
      createdAt: event.createdAt,
    }));
  }

  async getTopDepartments() {
    const depts = await this.prisma.department.findMany({
      include: {
        projects: {
          include: {
            contributionScores: true,
          }
        }
      }
    });

    const result = depts.map(dept => {
      let totalScore = 0;
      let count = 0;
      for (const proj of dept.projects) {
        for (const score of proj.contributionScores) {
          totalScore += score.totalScore;
          count++;
        }
      }
      return {
        id: dept.id,
        name: dept.name,
        avgScore: count > 0 ? Math.round(totalScore / count) : 0,
      };
    }).sort((a, b) => b.avgScore - a.avgScore).slice(0, 4);

    return result;
  }
}

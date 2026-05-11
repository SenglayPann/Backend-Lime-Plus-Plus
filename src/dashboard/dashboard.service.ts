import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../common/access/project-access.service';
import type { Role } from '../common/decorators/roles.decorator';

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private projectAccessService: ProjectAccessService,
  ) {}

  async getGlobalStats(actorId: string, actorRoles: Role[]) {
    const projectIds = await this.projectAccessService.getAccessibleProjectIds(
      actorId,
      actorRoles,
    );

    if (projectIds.length === 0) {
      return {
        activeStudents: 0,
        ongoingProjects: 0,
        pullRequests: 0,
        avgContribution: 0,
      };
    }

    const activeStudents = await this.prisma.projectMember.groupBy({
      by: ['userId'],
      where: {
        projectId: { in: projectIds },
      },
    });

    const ongoingProjectsCount = await this.prisma.project.count({
      where: { id: { in: projectIds }, status: 'ACTIVE' },
    });

    const prsCount = await this.prisma.pullRequest.count({
      where: { projectId: { in: projectIds } },
    });

    const scores = await this.prisma.contributionScore.findMany({
      where: { projectId: { in: projectIds } },
      select: { totalScore: true },
    });

    const avgContribution = scores.length > 0 
      ? scores.reduce((sum, s) => sum + s.totalScore, 0) / scores.length 
      : 0;

    return {
      activeStudents: activeStudents.length,
      ongoingProjects: ongoingProjectsCount,
      pullRequests: prsCount,
      avgContribution: Number(avgContribution.toFixed(1)),
    };
  }

  async getRecentActivity(actorId: string, actorRoles: Role[]) {
    const projectIds = await this.projectAccessService.getAccessibleProjectIds(
      actorId,
      actorRoles,
    );

    if (projectIds.length === 0) {
      return [];
    }

    const recentEvents = await this.prisma.contributionEvent.findMany({
      where: { projectId: { in: projectIds } },
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

  async getTopDepartments(actorId: string, actorRoles: Role[]) {
    const projectIds = await this.projectAccessService.getAccessibleProjectIds(
      actorId,
      actorRoles,
    );

    if (projectIds.length === 0) {
      return [];
    }

    const depts = await this.prisma.department.findMany({
      where: {
        projects: {
          some: { id: { in: projectIds } },
        },
      },
      include: {
        projects: {
          where: { id: { in: projectIds } },
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

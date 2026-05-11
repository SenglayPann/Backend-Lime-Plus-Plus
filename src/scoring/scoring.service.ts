import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { Project, Task, ContributionEvent } from '../generated/prisma';
import { ProjectAccessService } from '../common/access/project-access.service';
import type { Role } from '../common/decorators/roles.decorator';

export interface ScoringConfig {
  weights: {
    PR_MERGED: number;
    TASK_COMPLETED: number;
    PR_REVIEW_APPROVED: number;
  };
  multipliers: {
    difficulty: { LOW: number; MEDIUM: number; HIGH: number };
    timeliness: { early: number; onTime: number; late: number };
  };
  caps: {
    maxScorePerTask: number;
    maxReviewScorePerPR: number;
    maxReviewScorePercent: number;
  };
}

export interface ScoreBreakdown {
  PR_MERGED: Array<{ task: string; score: number; metadata: any }>;
  TASK_COMPLETED: Array<{ task: string; score: number; metadata: any }>;
  REVIEWS: Array<{ pr: string; score: number }>;
  OVERRIDES: Array<{ reason: string; score: number }>;
  [key: string]: any;
}

export interface ScoreData {
  totalScore: number;
  breakdown: ScoreBreakdown;
  reviewScore: number;
}

export const DEFAULT_SCORING_CONFIG: ScoringConfig = {
  weights: {
    PR_MERGED: 10,
    TASK_COMPLETED: 5,
    PR_REVIEW_APPROVED: 3,
  },
  multipliers: {
    difficulty: { LOW: 1.0, MEDIUM: 1.2, HIGH: 1.5 },
    timeliness: { early: 0.1, onTime: 0, late: -0.2 },
  },
  caps: {
    maxScorePerTask: 20,
    maxReviewScorePerPR: 5,
    maxReviewScorePercent: 0.2,
  },
};

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  constructor(
    private prisma: PrismaService,
    private projectAccessService: ProjectAccessService,
  ) {}

  async calculateProjectScores(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        contributionEvents: true,
      },
    });

    if (!project) return;
    if (project.status === 'LOCKED') {
      this.logger.warn(`Project ${projectId} is locked. Scores are immutable.`);
      return;
    }

    const config =
      (project.scoringConfig as unknown as ScoringConfig) ||
      DEFAULT_SCORING_CONFIG;

    // Fetch all related tasks to evaluate difficulty/timeliness
    const taskIds = project.contributionEvents.map((e) => e.referenceId);
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
    });
    const taskMap = new Map<string, Task>(tasks.map((t) => [t.id, t]));

    // Fetch all PR reviews to enforce caps
    // For PR_REVIEW_APPROVED, referenceId is the prReview.id
    const reviewIds = project.contributionEvents
      .filter((e) => e.type === 'PR_REVIEW_APPROVED')
      .map((e) => e.referenceId);
    const reviews = await this.prisma.prReview.findMany({
      where: { id: { in: reviewIds } },
      include: { pullRequest: true },
    });
    const reviewMap = new Map(reviews.map((r) => [r.id, r]));

    // Fetch overrides
    const overrides = await this.prisma.scoreOverride.findMany({
      where: { projectId },
    });

    // We store user scores in a map: userId -> ScoreData
    const userScores = new Map<string, ScoreData>();
    const getUserScore = (userId: string): ScoreData => {
      let score = userScores.get(userId);
      if (!score) {
        score = {
          totalScore: 0,
          breakdown: {
            PR_MERGED: [],
            TASK_COMPLETED: [],
            REVIEWS: [],
            OVERRIDES: [],
          },
          reviewScore: 0, // Track raw review score for capping
        };
        userScores.set(userId, score);
      }
      return score;
    };

    // Review caps tracker: PR -> Array of review scores
    const prReviewScores = new Map<string, number>();

    // 1. Process standard events
    for (const event of project.contributionEvents) {
      if (!this.isWithinEvaluationWindow(event, project)) continue;

      const eventType = event.type as keyof ScoringConfig['weights'];
      const base = config.weights[eventType] ?? 0;
      if (base === 0) continue;

      let modifier = 1.0;
      let finalScore = 0;
      const userScore = getUserScore(event.userId);

      if (event.type === 'PR_MERGED' || event.type === 'TASK_COMPLETED') {
        const task = taskMap.get(event.referenceId);
        if (task) {
          const difficultyKey =
            task.difficulty as keyof ScoringConfig['multipliers']['difficulty'];
          modifier *= config.multipliers.difficulty[difficultyKey] ?? 1.0;
          modifier *= this.getTimelinessModifier(
            task,
            config.multipliers.timeliness,
          );
        }
        finalScore = Math.round(base * modifier);

        // Anti-Gaming: Max score per task rule
        const cap = config.caps.maxScorePerTask;
        if (finalScore > cap) finalScore = cap;

        userScore.totalScore += finalScore;
        const key = event.type;
        userScore.breakdown[key].push({
          task: (task?.externalTaskId as string) ?? event.referenceId,
          score: finalScore,
          metadata: { difficulty: task?.difficulty, base },
        });
      }

      if (event.type === 'PR_REVIEW_APPROVED') {
        const review = reviewMap.get(event.referenceId);
        if (review) {
          if (review.pullRequest.authorId === event.userId) {
            // Cannot review own PR
            continue;
          }

          finalScore = Math.round(base * modifier);

          // Enforce Max Review Score Per PR
          const prId = review.pullRequestId;
          const currentPrScore = prReviewScores.get(prId) ?? 0;

          if (currentPrScore >= config.caps.maxReviewScorePerPR) {
            // PR already maxed out for review points, skip
            continue;
          }

          // Partial points if we hit the cap
          const remainingCap = config.caps.maxReviewScorePerPR - currentPrScore;
          const grantedScore = Math.min(finalScore, remainingCap);

          prReviewScores.set(prId, currentPrScore + grantedScore);

          userScore.reviewScore += grantedScore;
          userScore.totalScore += grantedScore;
          userScore.breakdown.REVIEWS.push({
            pr: review.pullRequest.externalPrId,
            score: grantedScore,
          });
        }
      }
    }

    // 2. Process Manual Overrides
    for (const override of overrides) {
      const userScore = getUserScore(override.userId);
      userScore.totalScore += override.delta;
      userScore.breakdown.OVERRIDES.push({
        reason: override.reason,
        score: override.delta,
      });
    }

    // 3. Apply Total Review Cap (e.g. 20% of total score)
    for (const userScore of userScores.values()) {
      if (userScore.totalScore > 0 && userScore.reviewScore > 0) {
        const maxReviewAllowed = Math.floor(
          userScore.totalScore * config.caps.maxReviewScorePercent,
        );
        if (userScore.reviewScore > maxReviewAllowed) {
          const deduction = userScore.reviewScore - maxReviewAllowed;
          userScore.totalScore -= deduction;
          userScore.breakdown.REVIEWS.push({
            pr: 'GLOBAL_CAP_DEDUCTION',
            score: -deduction,
          });
        }
      }

      // Ensure score doesn't go below 0 purely by algorithm (only manual overrides could result in negatives)
      // but let's allow negative if teacher explicitly overrides it.
    }

    // 4. Persist
    for (const [userId, scoreData] of userScores.entries()) {
      await this.prisma.contributionScore.upsert({
        where: {
          projectId_userId: { projectId, userId },
        },
        create: {
          projectId,
          userId,
          totalScore: scoreData.totalScore,
          breakdown: scoreData.breakdown,
        },
        update: {
          totalScore: scoreData.totalScore,
          breakdown: scoreData.breakdown,
        },
      });
    }

    this.logger.log(
      `Calculated scores for ${userScores.size} users in project ${projectId}`,
    );
  }

  private isWithinEvaluationWindow(
    event: ContributionEvent,
    project: Project,
  ): boolean {
    const createdAt = event.createdAt;
    const evalStart = project.evalStart;
    const evalEnd = project.evalEnd;

    if (evalStart && createdAt < evalStart) return false;
    if (evalEnd && createdAt > evalEnd) return false;
    return true;
  }

  private getTimelinessModifier(
    task: Task,
    conf: ScoringConfig['multipliers']['timeliness'],
  ): number {
    const dueDate = task.dueDate;
    const completedAt = task.completedAt;

    if (!dueDate || !completedAt) return 1.0;

    // Zero out time to compare strictly by day
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);

    const completed = new Date(completedAt);
    completed.setHours(0, 0, 0, 0);

    const timeDiff = completed.getTime() - due.getTime();
    const dayInMs = 24 * 60 * 60 * 1000;

    if (timeDiff < -dayInMs) return 1.0 + conf.early;
    if (timeDiff > dayInMs) return 1.0 + conf.late;
    return 1.0 + conf.onTime;
  }

  async getUserScore(
    projectId: string,
    userId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    await this.projectAccessService.assertCanViewProject(
      actorId,
      actorRoles,
      projectId,
    );

    if (actorId !== userId) {
      await this.assertCanViewOtherUserContribution(
        projectId,
        actorId,
        actorRoles,
      );
    }

    return this.prisma.contributionScore.findUnique({
      where: {
        projectId_userId: { projectId, userId },
      },
    });
  }

  async applyOverride(
    projectId: string,
    userId: string,
    delta: number,
    reason: string,
    actorId: string,
    actorRoles: Role[],
  ): Promise<void> {
    await this.projectAccessService.assertCanManageProject(
      actorId,
      actorRoles,
      projectId,
    );

    const membership = await this.prisma.projectMember.findFirst({
      where: {
        projectId,
        userId,
      },
      select: { id: true },
    });

    if (!membership) {
      throw new ForbiddenException(
        'Score overrides can only be applied to project members',
      );
    }

    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) throw new Error('Project not found');
    if (project.status === 'LOCKED')
      throw new Error('Cannot override score in a locked project');

    await this.prisma.scoreOverride.create({
      data: {
        projectId,
        userId,
        delta,
        reason,
        overriddenBy: actorId,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'SCORE_OVERRIDE',
        actorId,
        projectId,
        metadata: { userId, delta, reason },
      },
    });

    this.logger.log(
      `Override applied by ${actorId} for user ${userId}: ${delta > 0 ? '+' : ''}${delta} (${reason})`,
    );

    // Automatically trigger recalculation
    await this.calculateProjectScores(projectId);
  }

  @OnEvent('contribution.created')
  async handleContributionCreated(payload: { projectId: string }) {
    this.logger.log(
      `Received contribution.created event for project ${payload.projectId}`,
    );
    await this.calculateProjectScores(payload.projectId);
  }

  private async assertCanViewOtherUserContribution(
    projectId: string,
    actorId: string,
    actorRoles: Role[],
  ) {
    if (actorRoles.includes('ADMIN') || actorRoles.includes('ORGANIZATION_OWNER')) {
      return;
    }

    if (
      actorRoles.includes('DEPARTMENT_MANAGER') ||
      actorRoles.includes('PROJECT_MANAGER')
    ) {
      await this.projectAccessService.assertCanManageProject(
        actorId,
        actorRoles,
        projectId,
      );
      return;
    }

    throw new ForbiddenException(
      'You can only view your own contribution details',
    );
  }
}

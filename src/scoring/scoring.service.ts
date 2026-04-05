import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';

export const DEFAULT_SCORING_CONFIG = {
  weights: {
    PR_MERGED: 10,
    TASK_COMPLETED: 5,
    PR_REVIEW_APPROVED: 3
  },
  multipliers: {
    difficulty: { LOW: 1.0, MEDIUM: 1.2, HIGH: 1.5 },
    timeliness: { early: 0.10, onTime: 0, late: -0.20 }
  },
  caps: {
    maxScorePerTask: 20,
    maxReviewScorePerPR: 5,
    maxReviewScorePercent: 0.20
  }
};

@Injectable()
export class ScoringService {
  private readonly logger = new Logger(ScoringService.name);

  constructor(private prisma: PrismaService) {}

  async calculateProjectScores(projectId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: {
        contributionEvents: true,
      }
    });

    if (!project) return;
    if (project.status === 'LOCKED') {
      this.logger.warn(`Project ${projectId} is locked. Scores are immutable.`);
      return;
    }

    const config = (project as any).scoringConfig ? (project as any).scoringConfig : DEFAULT_SCORING_CONFIG;
    
    // Fetch all related tasks to evaluate difficulty/timeliness
    const taskIds = project.contributionEvents.map(e => e.referenceId);
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds } },
    });
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    // Fetch all PR reviews to enforce caps
    // For PR_REVIEW_APPROVED, referenceId is the prReview.id
    const reviewIds = project.contributionEvents.filter(e => e.type === 'PR_REVIEW_APPROVED').map(e => e.referenceId);
    const reviews = await this.prisma.prReview.findMany({
      where: { id: { in: reviewIds } },
      include: { pullRequest: true },
    });
    const reviewMap = new Map(reviews.map(r => [r.id, r]));

    // Fetch overrides
    const overrides = await this.prisma.scoreOverride.findMany({
      where: { projectId },
    });

    // We store user scores in a map: userId -> ScoreData
    const userScores = new Map<string, any>();
    const getUserScore = (userId: string) => {
      if (!userScores.has(userId)) {
        userScores.set(userId, {
          totalScore: 0,
          breakdown: {
            PR_MERGED: [],
            TASK_COMPLETED: [],
            REVIEWS: [],
            OVERRIDES: [],
          },
          reviewScore: 0, // Track raw review score for capping
        });
      }
      return userScores.get(userId);
    };

    // Review caps tracker: PR -> Array of review scores
    const prReviewScores = new Map<string, number>();

    // 1. Process standard events
    for (const event of project.contributionEvents) {
      if (!this.isWithinEvaluationWindow(event, project)) continue;

      const base = config.weights[event.type] ?? 0;
      if (base === 0) continue;

      let modifier = 1.0;
      let finalScore = 0;
      const userScore = getUserScore(event.userId);

      if (event.type === 'PR_MERGED' || event.type === 'TASK_COMPLETED') {
        const task = taskMap.get(event.referenceId);
        if (task) {
          modifier *= config.multipliers.difficulty[task.difficulty] ?? 1.0;
          modifier *= this.getTimelinessModifier(task, config.multipliers.timeliness);
        }
        finalScore = Math.round(base * modifier);
        
        // Anti-Gaming: Max score per task rule
        const cap = config.caps.maxScorePerTask;
        if (finalScore > cap) finalScore = cap;
        
        userScore.totalScore += finalScore;
        const key = event.type as 'PR_MERGED' | 'TASK_COMPLETED';
        userScore.breakdown[key].push({
          task: task?.externalTaskId ?? event.referenceId,
          score: finalScore,
          metadata: { difficulty: task?.difficulty, base }
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
            score: grantedScore
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
        score: override.delta
      });
    }

    // 3. Apply Total Review Cap (e.g. 20% of total score)
    for (const [userId, userScore] of userScores.entries()) {
      if (userScore.totalScore > 0 && userScore.reviewScore > 0) {
        const maxReviewAllowed = Math.floor(userScore.totalScore * config.caps.maxReviewScorePercent);
        if (userScore.reviewScore > maxReviewAllowed) {
          const deduction = userScore.reviewScore - maxReviewAllowed;
          userScore.totalScore -= deduction;
          userScore.breakdown.REVIEWS.push({
            pr: 'GLOBAL_CAP_DEDUCTION',
            score: -deduction
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
          projectId_userId: { projectId, userId }
        },
        create: {
          projectId,
          userId,
          totalScore: scoreData.totalScore,
          breakdown: scoreData.breakdown
        },
        update: {
          totalScore: scoreData.totalScore,
          breakdown: scoreData.breakdown
        }
      });
    }

    this.logger.log(`Calculated scores for ${userScores.size} users in project ${projectId}`);
  }

  private isWithinEvaluationWindow(event: any, project: any): boolean {
    if (project.evalStart && event.createdAt < project.evalStart) return false;
    if (project.evalEnd && event.createdAt > project.evalEnd) return false;
    return true;
  }

  private getTimelinessModifier(task: any, conf: any): number {
    if (!task.dueDate || !task.completedAt) return 1.0;

    // Zero out time to compare strictly by day
    const due = new Date(task.dueDate);
    due.setHours(0, 0, 0, 0);

    const completed = new Date(task.completedAt);
    completed.setHours(0, 0, 0, 0);

    const timeDiff = completed.getTime() - due.getTime();
    const dayInMs = 24 * 60 * 60 * 1000;

    if (timeDiff < -dayInMs) return 1.0 + conf.early;
    if (timeDiff > dayInMs) return 1.0 + conf.late;
    return 1.0 + conf.onTime;
  }

  async applyOverride(
    projectId: string,
    userId: string,
    actorId: string,
    delta: number,
    reason: string
  ): Promise<void> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new Error('Project not found');
    if (project.status === 'LOCKED') throw new Error('Cannot override score in a locked project');

    await this.prisma.scoreOverride.create({
      data: {
        projectId,
        userId,
        delta,
        reason,
        overriddenBy: actorId,
      }
    });

    await this.prisma.auditLog.create({
      data: {
        action: 'SCORE_OVERRIDE',
        actorId,
        projectId,
        metadata: { userId, delta, reason }
      }
    });

    this.logger.log(`Override applied by ${actorId} for user ${userId}: ${delta > 0 ? '+' : ''}${delta} (${reason})`);
    
    // Automatically trigger recalculation
    await this.calculateProjectScores(projectId);
  }

  @OnEvent('contribution.created')
  async handleContributionCreated(payload: { projectId: string }) {
    this.logger.log(`Received contribution.created event for project ${payload.projectId}`);
    await this.calculateProjectScores(payload.projectId);
  }
}

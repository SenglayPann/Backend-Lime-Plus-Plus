import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Request,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ScoringService } from './scoring.service';
import { ScoreOverrideDto } from './dto/score-override.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Scoring & Contributions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class ScoringController {
  constructor(private readonly scoringService: ScoringService) {}

  @Get('projects/:projectId/users/:userId/contribution')
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({
    summary: 'Get user contribution breakdown for a project (Project Members+)',
  })
  async getContribution(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Request() req: RequestWithUser,
  ) {
    const scoreInfo = await this.scoringService.getUserScore(
      projectId,
      userId,
      req.user.id,
      req.user.roles,
    );
    if (!scoreInfo) throw new NotFoundException('Contribution data not found');
    return scoreInfo;
  }

  @Post('projects/:projectId/users/:userId/override')
  @Roles(Role.DEPARTMENT_MANAGER) // spec says "Teacher", department manager mapped here
  @ApiOperation({ summary: 'Apply manual score override (Dept Manager+)' })
  async applyOverride(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() dto: ScoreOverrideDto,
    @Request() req: RequestWithUser,
  ) {
    return this.scoringService.applyOverride(
      projectId,
      userId,
      dto.adjustment,
      dto.reason,
      req.user.id,
      req.user.roles,
    );
  }
}

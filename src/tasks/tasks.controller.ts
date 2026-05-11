import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { TasksService } from './tasks.service';
import { AssignTaskDto } from './dto/assign-task.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { Role } from '../generated/prisma';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import type { RequestWithUser } from '../common/types/request.interface';

@ApiTags('Tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasksService: TasksService) {}

  @Get()
  @Roles(Role.PROJECT_MEMBER)
  @ApiOperation({ summary: 'List tasks (Project Members+)' })
  @ApiQuery({ name: 'project_id', required: false })
  @ApiQuery({ name: 'assignee_id', required: false })
  @ApiQuery({ name: 'status', required: false })
  async findAll(
    @Query('project_id') projectId?: string,
    @Query('assignee_id') assigneeId?: string,
    @Query('status') status?: string,
    @Request() req?: RequestWithUser,
  ) {
    return this.tasksService.findAll(
      req!.user.id,
      req!.user.roles,
      projectId,
      assigneeId,
      status,
    );
  }

  @Post(':id/assign')
  @Roles(Role.PROJECT_MANAGER)
  @ApiOperation({ summary: 'Assign task to a user (Project Manager+)' })
  async assignTask(
    @Param('id') id: string,
    @Body() dto: AssignTaskDto,
    @Request() req: RequestWithUser,
  ) {
    return this.tasksService.assignTask(
      id,
      dto.assignee_id,
      req.user.id,
      req.user.roles,
    );
  }
}

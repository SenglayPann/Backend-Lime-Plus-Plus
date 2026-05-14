import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { TaskStatus } from '../../generated/prisma';

export class ListTasksQueryDto {
  @IsUUID()
  @IsOptional()
  project_id?: string;

  @IsUUID()
  @IsOptional()
  assignee_id?: string;

  @IsEnum(TaskStatus)
  @IsOptional()
  status?: TaskStatus;
}

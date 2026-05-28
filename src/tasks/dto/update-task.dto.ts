import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  ValidateIf,
} from 'class-validator';
import { TaskDifficulty } from '../../generated/prisma';

/**
 * Lime++-owned task fields. Difficulty and due date are not synced from
 * the GitHub Project board — they live in Lime++ so teachers can edit
 * them without having to configure custom fields on the upstream board.
 */
export class UpdateTaskDto {
  @ApiPropertyOptional({ enum: TaskDifficulty, example: 'MEDIUM' })
  @IsOptional()
  @IsEnum(TaskDifficulty)
  difficulty?: TaskDifficulty;

  @ApiPropertyOptional({
    example: '2026-06-01',
    description:
      'Due date as ISO date (YYYY-MM-DD) or ISO datetime. Pass null to clear.',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsDateString()
  due_date?: string | null;
}

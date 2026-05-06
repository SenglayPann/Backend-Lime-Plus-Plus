import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  IsObject,
} from 'class-validator';

export class CreateProjectDto {
  @ApiProperty({ example: 'dept_456', description: 'The ID of the department' })
  @IsUUID()
  @IsNotEmpty()
  department_id: string;

  @ApiProperty({ example: 'Distributed Systems Project' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'PVT_kwHO...', description: 'GitHub Project V2 ID' })
  @IsString()
  @IsNotEmpty()
  github_project_id: string;

  @ApiProperty({
    example: 'org/repo',
    description: 'GitHub repository in owner/repo format',
  })
  @IsString()
  @IsNotEmpty()
  repository: string;

  @ApiProperty({
    example: { start: '2026-03-01', end: '2026-05-30' },
    description: 'Evaluation window for scoring',
  })
  @IsObject()
  @IsOptional()
  evaluation_window?: {
    start: string;
    end: string;
  };
}

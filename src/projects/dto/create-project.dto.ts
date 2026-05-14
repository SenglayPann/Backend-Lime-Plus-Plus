import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  IsOptional,
  IsUUID,
  IsDateString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class EvaluationWindowDto {
  @ApiProperty({ example: '2026-03-01', required: false })
  @IsDateString()
  @IsOptional()
  start?: string;

  @ApiProperty({ example: '2026-05-30', required: false })
  @IsDateString()
  @IsOptional()
  end?: string;
}

export class CreateProjectDto {
  @ApiProperty({ example: 'dept_456', description: 'The ID of the department' })
  @IsUUID()
  @IsNotEmpty()
  department_id: string;

  @ApiProperty({
    example: 'd6c54a4d-8a13-4a99-9d19-901c40b3a8ff',
    description:
      'User who will manage this project. Defaults to the creator when omitted.',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  project_manager_id?: string;

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
    type: EvaluationWindowDto,
  })
  @ValidateNested()
  @Type(() => EvaluationWindowDto)
  @IsOptional()
  evaluation_window?: EvaluationWindowDto;
}

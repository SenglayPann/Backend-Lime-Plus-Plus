import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

export const MAX_SCORE_OVERRIDE_DELTA = 100;
export const MAX_SCORE_OVERRIDE_REASON_LENGTH = 500;

export class ScoreOverrideDto {
  @ApiProperty({
    example: -10,
    description: 'Score adjustment (can be negative)',
  })
  @IsInt()
  @Min(-MAX_SCORE_OVERRIDE_DELTA)
  @Max(MAX_SCORE_OVERRIDE_DELTA)
  @IsNotEmpty()
  adjustment: number;

  @ApiProperty({
    example: 'Unequal task complexity',
    description: 'Reason for the override',
  })
  @IsString()
  @MaxLength(MAX_SCORE_OVERRIDE_REASON_LENGTH)
  @IsNotEmpty()
  reason: string;
}

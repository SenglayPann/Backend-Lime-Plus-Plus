import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsInt, IsString } from 'class-validator';

export class ScoreOverrideDto {
  @ApiProperty({
    example: -10,
    description: 'Score adjustment (can be negative)',
  })
  @IsInt()
  @IsNotEmpty()
  adjustment: number;

  @ApiProperty({
    example: 'Unequal task complexity',
    description: 'Reason for the override',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;
}

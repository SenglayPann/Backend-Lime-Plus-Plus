import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class UpdateDepartmentDto {
  @ApiProperty({ example: 'Computer Science', required: false })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  name?: string;

  @ApiProperty({
    example: 'd6c54a4d-8a13-4a99-9d19-901c40b3a8ff',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  organization_id?: string;

  @ApiProperty({
    example: 'Department for software engineering and distributed systems',
    required: false,
  })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  description?: string;
}

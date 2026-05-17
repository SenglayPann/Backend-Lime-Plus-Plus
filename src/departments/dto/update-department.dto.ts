import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';

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

  @ApiProperty({
    example: 'd6c54a4d-8a13-4a99-9d19-901c40b3a8ff',
    description: 'User to add as a department manager',
    required: false,
    nullable: true,
  })
  @IsUUID()
  @IsOptional()
  @ValidateIf((o) => o.manager_user_id !== null && o.manager_user_id !== '')
  manager_user_id?: string | null;
}

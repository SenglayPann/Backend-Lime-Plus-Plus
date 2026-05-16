import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateDepartmentDto {
  @ApiProperty({
    example: 'org_123',
    description: 'The ID of the organization',
  })
  @IsUUID()
  @IsNotEmpty()
  organization_id: string;

  @ApiProperty({ example: 'Computer Science' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Academic department for CS students', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    example: '7cf8c342-8551-4a62-8dd9-3f6f6c7e6d42',
    description: 'Optional user ID to assign atomically as department manager',
    required: false,
  })
  @IsUUID()
  @IsOptional()
  manager_user_id?: string;
}

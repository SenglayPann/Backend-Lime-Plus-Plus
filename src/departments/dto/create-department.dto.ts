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
}

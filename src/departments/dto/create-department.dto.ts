import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

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
}

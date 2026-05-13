import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateOrganizationDto {
  @ApiProperty({ example: 'Engineering Faculty', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({
    example: 'enterprise',
    description: 'License plan for the organization',
    required: false,
  })
  @IsString()
  @IsOptional()
  license_plan?: string;
}

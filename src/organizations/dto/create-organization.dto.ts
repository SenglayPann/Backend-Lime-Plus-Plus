import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateOrganizationDto {
  @ApiProperty({ example: 'Engineering Faculty' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    example: 'enterprise',
    description: 'License plan for the organization',
  })
  @IsString()
  @IsNotEmpty()
  license_plan: string;
}

import { IsArray, IsEnum, IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class AllowlistEntryDto {
  @ApiProperty({ enum: ['EMAIL', 'DOMAIN', 'GITHUB_USERNAME'] })
  @IsEnum(['EMAIL', 'DOMAIN', 'GITHUB_USERNAME'])
  type: 'EMAIL' | 'DOMAIN' | 'GITHUB_USERNAME';

  @ApiProperty({ example: 'john@acme.com' })
  @IsString()
  @IsNotEmpty()
  value: string;
}

export class AddAllowlistEntriesDto {
  @ApiProperty({ type: [AllowlistEntryDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AllowlistEntryDto)
  entries: AllowlistEntryDto[];
}

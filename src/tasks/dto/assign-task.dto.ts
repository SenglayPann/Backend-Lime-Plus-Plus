import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class AssignTaskDto {
  @ApiProperty({ example: 'user_789', description: 'The ID of the user to assign the task to' })
  @IsUUID()
  @IsNotEmpty()
  assignee_id: string;
}

import { Request } from 'express';
import { Role } from '../decorators/roles.decorator';

export interface RequestWithUser extends Request {
  user: {
    id: string;
    githubUserId: string;
    email: string;
    name: string | null;
    avatarUrl: string | null;
    roles: Role[];
  };
}

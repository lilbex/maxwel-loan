import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { type CreateUserRequest, createUserRequest } from '@loan-platform/api-client';
import { Auth, type AuthContext, RequirePermissions } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { UsersService } from './users.service.js';

@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly usersService: UsersService) {}

  @Get()
  @RequirePermissions('users.read')
  list(@Auth() auth: AuthContext) {
    return this.usersService.list(auth);
  }

  @Get('roles')
  @RequirePermissions('users.read')
  roles(@Auth() auth: AuthContext) {
    return this.usersService.roles(auth);
  }

  @Post()
  @RequirePermissions('users.manage')
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(createUserRequest)) body: CreateUserRequest) {
    return this.usersService.create(auth, body);
  }
}

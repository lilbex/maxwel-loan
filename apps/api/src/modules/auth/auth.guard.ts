import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  type AuthedRequest,
  PUBLIC_ROUTE,
  REQUIRED_PERMISSIONS,
} from '../../common/request-context.js';
import { AuthService } from './auth.service.js';

export const SESSION_COOKIE = 'lp_session';

/** Global guard: every route needs a valid session unless it is explicitly marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const cookies = request.cookies as Record<string, string | undefined>;
    const auth = await this.authService.authenticate(cookies[SESSION_COOKIE], {
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    if (!auth) throw new UnauthorizedException('Sign in to continue');
    request.auth = auth;

    const required = this.reflector.getAllAndOverride<string[]>(REQUIRED_PERMISSIONS, targets) ?? [];
    if (!required.every((code) => auth.permissions.has(code))) {
      throw new ForbiddenException('Your role does not allow this action');
    }
    return true;
  }
}

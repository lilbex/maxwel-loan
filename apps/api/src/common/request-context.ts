import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export interface AuthContext {
  tenantId: string;
  userId: string;
  sessionId: string;
  permissions: ReadonlySet<string>;
  ipAddress: string | null;
  userAgent: string | null;
}

export type AuthedRequest = Request & { auth?: AuthContext };

export const PUBLIC_ROUTE = 'public-route';
export const REQUIRED_PERMISSIONS = 'required-permissions';

export const Public = () => SetMetadata(PUBLIC_ROUTE, true);
export const RequirePermissions = (...codes: string[]) => SetMetadata(REQUIRED_PERMISSIONS, codes);

export const Auth = createParamDecorator((_: unknown, context: ExecutionContext): AuthContext => {
  const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new Error('@Auth() used on a public route');
  return auth;
});

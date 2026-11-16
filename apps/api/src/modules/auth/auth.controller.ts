import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { type LoginRequest, loginRequest } from '@loan-platform/api-client';
import { Auth, type AuthContext, Public } from '../../common/request-context.js';
import { ZodPipe } from '../../common/zod.pipe.js';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { SESSION_COOKIE } from './auth.guard.js';
import { AuthService } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private cookieOptions() {
    return { httpOnly: true, sameSite: 'strict', secure: this.config.COOKIE_SECURE, path: '/' } as const;
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(loginRequest)) body: LoginRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { token, expiresAt, me } = await this.authService.login(body, {
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
    response.cookie(SESSION_COOKIE, token, { ...this.cookieOptions(), expires: expiresAt });
    return me;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) response: Response) {
    await this.authService.logout(auth);
    response.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('me')
  me(@Auth() auth: AuthContext) {
    return this.authService.me(auth);
  }
}

import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { Public, type AuthenticatedActor } from '@/common';
import { loadConfig } from '@/config';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { toLoginResponse, toUserView, type LoginResponse } from './dto/auth-response';
import {
  LoginSchema,
  LogoutSchema,
  RefreshSchema,
  type LoginDto,
  type LogoutDto,
  type RefreshDto,
} from './dto/auth.dto';
import type { TokenContext } from './token.service';

const config = loadConfig();

/**
 * A tighter limit than the global one. Credential endpoints are the only place
 * where an attacker gets to guess, so RATE_LIMIT_AUTH_MAX (10/min) applies here
 * rather than the 120/min every other route gets.
 */
const AUTH_THROTTLE = {
  default: {
    limit: config.security.rateLimit.authMax,
    ttl: config.security.rateLimit.ttlSeconds * 1000,
  },
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Authenticate with a portal or legacy credential',
    description:
      'First login for a user is verified against the legacy Ticket-IT database and ' +
      'replicates them into the portal database. Later logins are served entirely from ' +
      'the portal database.',
  })
  @ApiZodBody(LoginSchema, {
    description: 'The legacy `Users.Login` value — not the email address, which is not unique.',
    example: { login: 'your-legacy-login', password: 'your-password' },
  })
  async login(
    @Body(zodBody(LoginSchema)) body: LoginDto,
    @Req() request: FastifyRequest,
  ): Promise<LoginResponse> {
    const result = await this.auth.login(body.login, body.password, requestContext(request));
    await this.auth.markLoggedIn(result.user.id);

    return toLoginResponse(result.tokens, result.user);
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({ summary: 'Exchange a refresh token for a new token pair' })
  @ApiZodBody(RefreshSchema, { example: { refreshToken: 'the-refresh-token-from-login' } })
  async refresh(
    @Body(zodBody(RefreshSchema)) body: RefreshDto,
    @Req() request: FastifyRequest,
  ): Promise<LoginResponse> {
    const result = await this.auth.refresh(body.refreshToken, requestContext(request));
    return toLoginResponse(result.tokens, result.user);
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke a refresh token',
    description:
      'Public and idempotent: a client holding an expired access token must still be ' +
      'able to end its session, and an unknown token is not an error.',
  })
  @ApiZodBody(LogoutSchema, { example: { refreshToken: 'the-refresh-token-to-revoke' } })
  async logout(@Body(zodBody(LogoutSchema)) body: LogoutDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }

  @Get('me')
  // Matches the scheme name registered in swagger.setup.ts. Without it the
  // Authorize button exists but Swagger sends no token, so "Try it out" 401s
  // and looks like a broken endpoint rather than a missing header.
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'The currently authenticated user' })
  async me(@CurrentUser() actor: AuthenticatedActor) {
    const user = await this.auth.findActiveUser(actor.userId);
    return toUserView(user);
  }
}

/**
 * Client IP and user agent, recorded against the refresh token so a session can
 * be recognised in an audit trail.
 *
 * `x-forwarded-for` is honoured only when TRUST_PROXY is on — behind no proxy
 * it is a client-supplied header and trusting it would let anyone forge the
 * origin of their own session.
 */
function requestContext(request: FastifyRequest): TokenContext {
  const forwarded = config.security.trustProxy ? request.headers['x-forwarded-for'] : undefined;

  const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim();

  return {
    ip: forwardedIp || request.ip,
    userAgent: request.headers['user-agent'],
  };
}

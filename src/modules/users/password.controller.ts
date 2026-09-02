import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { Public } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { loadConfig } from '@/config';
import {
  RequestPasswordResetSchema,
  ResetPasswordSchema,
  type RequestPasswordResetDto,
  type ResetPasswordDto,
} from './dto/invitation.dto';
import { PasswordResetService } from './password-reset.service';

const config = loadConfig();

const AUTH_THROTTLE = {
  default: {
    limit: config.security.rateLimit.authMax,
    ttl: config.security.rateLimit.ttlSeconds * 1000,
  },
};

@ApiTags('auth')
@Controller('password')
export class PasswordController {
  constructor(private readonly reset: PasswordResetService) {}

  @Post('forgot')
  @Public()
  @HttpCode(204)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Request a password-reset link',
    description:
      'Always answers 204, whether or not the identifier matches an account. Responding ' +
      'differently would let anyone test who has an account here. Users replicated from the ' +
      'legacy Ticket-IT system are not eligible and receive no email — their password lives ' +
      'in that system.',
  })
  @ApiZodBody(RequestPasswordResetSchema, { example: { identifier: 'jo@partner.example' } })
  async forgot(
    @Body(zodBody(RequestPasswordResetSchema)) body: RequestPasswordResetDto,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.reset.request(body.identifier, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  @Post('reset')
  @Public()
  @HttpCode(204)
  @Throttle(AUTH_THROTTLE)
  @ApiOperation({
    summary: 'Set a new password with a reset token',
    description: 'Revokes every existing session on success.',
  })
  @ApiZodBody(ResetPasswordSchema, {
    example: { token: 'the-token-from-the-reset-email', password: 'a-long-passphrase' },
  })
  async complete(@Body(zodBody(ResetPasswordSchema)) body: ResetPasswordDto): Promise<void> {
    await this.reset.complete(body.token, body.password);
  }
}

import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { PricingService } from './pricing.service';
import { QuoteSchema, type QuoteDto } from './dto/rate-card.dto';
import {
  toActiveRateCardView,
  toQuotedLineView,
  type ActiveRateCardView,
  type QuotedLineView,
} from './dto/rate-card-response';

/**
 * What an account pays — the read side of BE-04.
 *
 * PRICING_VIEW, which every customer role holds: seeing your own contract price
 * is the point of having a contract. Pricing on behalf of another account, or
 * as of another instant, is administrator-only and is enforced in the service
 * rather than here, because both are parameters on the same call.
 */
@ApiTags('pricing')
@ApiBearerAuth('access-token')
@RequirePermissions(Permission.PRICING_VIEW)
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Post('quote')
  // A quote writes nothing. POST because the request carries a list of lines
  // that would not survive a query string, and 200 rather than 201 because
  // nothing was created.
  @HttpCode(200)
  @ApiOperation({
    summary: 'Price a batch of lines for this account',
    description:
      'Batched because a product grid needs every tile priced at once. Each line comes back ' +
      'with the contract price, the catalogue price it is measured against, the rule that ' +
      'produced it (`source`) and the ladder as this account sees it. Products the caller may ' +
      'not see are omitted rather than raising, so one unpublished SKU cannot blank a page.\n\n' +
      '`at` and `accountId` are administrator-only: a customer is always quoted against their ' +
      'own account, as of now.',
  })
  @ApiZodBody(QuoteSchema, {
    example: {
      lines: [
        { productId: 'prd_01hzy1', quantity: 500 },
        { productId: 'prd_01hzy2', quantity: 5000 },
      ],
    },
  })
  async quote(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(QuoteSchema)) body: QuoteDto,
  ): Promise<{ lines: QuotedLineView[] }> {
    const lines = await this.pricing.quote(actor, body);
    return { lines: lines.map(toQuotedLineView) };
  }

  @Get('active-rate-card')
  @ApiOperation({
    summary: 'The rate card pricing this account right now',
    description:
      'Null when there is no contract in force, which is the ordinary case rather than an ' +
      'error. Administrators may pass `accountId` to ask on behalf of a customer.',
  })
  async activeCard(
    @CurrentUser() actor: AuthenticatedActor,
    @Query('accountId') accountId?: string,
  ): Promise<ActiveRateCardView | null> {
    return toActiveRateCardView(await this.pricing.myActiveCard(actor, accountId));
  }
}

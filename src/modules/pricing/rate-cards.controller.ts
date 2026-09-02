import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor, type OffsetPage } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { RateCardsService } from './rate-cards.service';
import {
  ChangeRateCardStatusSchema,
  CreateRateCardSchema,
  ListRateCardItemsQuerySchema,
  ListRateCardsQuerySchema,
  SetRateCardItemsSchema,
  UpdateRateCardSchema,
  type ChangeRateCardStatusDto,
  type CreateRateCardDto,
  type ListRateCardItemsQueryDto,
  type ListRateCardsQueryDto,
  type SetRateCardItemsDto,
  type UpdateRateCardDto,
} from './dto/rate-card.dto';
import {
  toRateCardItemView,
  toRateCardView,
  type RateCardItemView,
  type RateCardView,
} from './dto/rate-card-response';

/**
 * Rate card administration (SOW BE-04), behind PRICING_MANAGE — which the role
 * baseline gives to no customer role, because a negotiated price list is the
 * platform operator's to write.
 *
 * Reads are PRICING_VIEW so a customer can see the contract that prices them,
 * and the service pins any non-administrator to their own account regardless of
 * what they ask for.
 */
@ApiTags('pricing')
@ApiBearerAuth('access-token')
@Controller('pricing/rate-cards')
export class RateCardsController {
  constructor(private readonly rateCards: RateCardsService) {}

  @Get()
  @RequirePermissions(Permission.PRICING_VIEW)
  @ApiOperation({
    summary: 'List rate cards',
    description:
      'An administrator sees every account and may filter by `accountId`. Everyone else sees ' +
      'their own account, whatever they ask for. `activeAt` narrows to the cards in force at ' +
      'an instant.',
  })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListRateCardsQuerySchema)) query: ListRateCardsQueryDto,
  ): Promise<OffsetPage<RateCardView>> {
    const page = await this.rateCards.list(actor, query);
    return { ...page, items: page.items.map((card) => toRateCardView(card)) };
  }

  @Get(':rateCardId')
  @RequirePermissions(Permission.PRICING_VIEW)
  @ApiOperation({
    summary: 'One rate card, with its items',
    description:
      'A card belonging to another account is reported as missing rather than forbidden: ' +
      'confirming that a contract exists for another company is itself a disclosure.',
  })
  async findOne(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('rateCardId') rateCardId: string,
  ): Promise<RateCardView> {
    return toRateCardView(await this.rateCards.findById(actor, rateCardId));
  }

  @Get(':rateCardId/items')
  @RequirePermissions(Permission.PRICING_VIEW)
  @ApiOperation({
    summary: 'The items on one rate card, paged',
    description:
      'A negotiated price list runs to hundreds of lines, so the detail screen pages through ' +
      'them here rather than pulling all of them on every card read. `effectivePrice` is the ' +
      "unit price at the product's minimum order quantity, and `source` says which rule " +
      'produced it.',
  })
  async listItems(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('rateCardId') rateCardId: string,
    @Query(zodBody(ListRateCardItemsQuerySchema)) query: ListRateCardItemsQueryDto,
  ): Promise<OffsetPage<RateCardItemView>> {
    // findSummary, not findById: the latter includes every item on the card,
    // which would load the whole price list on each page of a paged read.
    const card = await this.rateCards.findSummary(actor, rateCardId);
    const page = await this.rateCards.listItems(actor, rateCardId, query);
    return { ...page, items: page.items.map((item) => toRateCardItemView(item, card)) };
  }

  @Post()
  @RequirePermissions(Permission.PRICING_MANAGE)
  @ApiOperation({
    summary: 'Create a rate card',
    description:
      'Always created as DRAFT. Activation is a separate transition, because it is the moment ' +
      'the card starts deciding what a customer pays and because it is the write the ' +
      'one-live-contract-per-account rule has to arbitrate.',
  })
  @ApiZodBody(CreateRateCardSchema, {
    example: {
      accountId: 'acc_01hzy0',
      name: 'Acme Enterprise Tier A',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: '2026-12-31T00:00:00.000Z',
      defaultDiscountPercent: '15',
      items: [
        { productId: 'prd_01hzy1', fixedPrice: '120.00' },
        {
          productId: 'prd_01hzy2',
          discountPercent: '18.5',
          tiers: [{ minQuantity: 5000, discountPercent: '22' }],
        },
      ],
    },
  })
  async create(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(CreateRateCardSchema)) body: CreateRateCardDto,
  ): Promise<RateCardView> {
    return toRateCardView(await this.rateCards.create(body, actor));
  }

  @Patch(':rateCardId')
  @RequirePermissions(Permission.PRICING_MANAGE)
  @ApiOperation({
    summary: 'Update a rate card',
    description:
      '`accountId` cannot be changed: moving a signed contract to a different customer is not ' +
      'a PATCH. An ACTIVE card is editable — a price correction on a live contract is an ' +
      'ordinary thing to need, and every edit is audited — but an ARCHIVED one is not.',
  })
  @ApiZodBody(UpdateRateCardSchema, {
    example: { defaultDiscountPercent: '17.5', effectiveTo: '2027-06-30T00:00:00.000Z' },
  })
  async update(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('rateCardId') rateCardId: string,
    @Body(zodBody(UpdateRateCardSchema)) body: UpdateRateCardDto,
  ): Promise<RateCardView> {
    return toRateCardView(await this.rateCards.update(rateCardId, body, actor));
  }

  @Post(':rateCardId/status')
  @RequirePermissions(Permission.PRICING_MANAGE)
  @ApiOperation({
    summary: 'Activate or archive a rate card',
    description:
      'DRAFT to ACTIVE to ARCHIVED, one way. Activating fails with 409 when another card is ' +
      'already active for the account over any part of the same period — that is a database ' +
      'constraint, not a check, so two administrators activating at the same instant cannot ' +
      'both succeed.',
  })
  @ApiZodBody(ChangeRateCardStatusSchema, {
    example: { status: 'ACTIVE', reason: 'Signed 12 Jan' },
  })
  async changeStatus(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('rateCardId') rateCardId: string,
    @Body(zodBody(ChangeRateCardStatusSchema)) body: ChangeRateCardStatusDto,
  ): Promise<RateCardView> {
    return toRateCardView(await this.rateCards.changeStatus(rateCardId, body, actor));
  }

  @Post(':rateCardId/items')
  @RequirePermissions(Permission.PRICING_MANAGE)
  @ApiOperation({
    summary: 'Set the terms for one or more products',
    description:
      'Upserts by product. `replaceAll` removes every product not in the payload — off by ' +
      'default, because a partial upload that silently deleted 400 negotiated lines is not ' +
      'recoverable from the UI. The whole payload is one transaction.',
  })
  @ApiZodBody(SetRateCardItemsSchema, {
    example: {
      replaceAll: false,
      items: [
        { productId: 'prd_01hzy1', fixedPrice: '118.50' },
        { productId: 'prd_01hzy3', discountPercent: '12' },
      ],
    },
  })
  async setItems(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('rateCardId') rateCardId: string,
    @Body(zodBody(SetRateCardItemsSchema)) body: SetRateCardItemsDto,
  ): Promise<RateCardView> {
    return toRateCardView(await this.rateCards.setItems(rateCardId, body, actor));
  }

  @Delete(':rateCardId/items/:productId')
  @HttpCode(204)
  @RequirePermissions(Permission.PRICING_MANAGE)
  @ApiOperation({
    summary: 'Remove one product from a rate card',
    description:
      "The product then falls back to the card's default discount, or to the catalogue price " +
      'if the card has no default.',
  })
  async removeItem(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('rateCardId') rateCardId: string,
    @Param('productId') productId: string,
  ): Promise<void> {
    await this.rateCards.removeItem(rateCardId, productId, actor);
  }

  @Delete(':rateCardId')
  @HttpCode(204)
  @RequirePermissions(Permission.PRICING_MANAGE)
  @ApiOperation({
    summary: 'Delete a rate card',
    description:
      'A soft delete. Orders priced under the card reference it, so the row survives; it is ' +
      'archived on the way out, which also releases its slot in the overlap rule so a ' +
      'successor can be activated.',
  })
  async remove(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('rateCardId') rateCardId: string,
  ): Promise<void> {
    await this.rateCards.remove(rateCardId, actor);
  }
}

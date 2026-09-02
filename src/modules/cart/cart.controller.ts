import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { CartService } from './cart.service';
import {
  AddCartLineSchema,
  CartQuerySchema,
  SetCheckoutDetailsSchema,
  UpdateCartLineSchema,
  ValidateCartQuerySchema,
  type AddCartLineDto,
  type CartQueryDto,
  type SetCheckoutDetailsDto,
  type UpdateCartLineDto,
  type ValidateCartQueryDto,
} from './dto/cart.dto';
import {
  toCartValidationView,
  toCartView,
  type CartValidationView,
  type CartView,
} from './dto/cart-response';

/**
 * The basket and checkout validation (SOW BE-05).
 *
 * `ORDER_CREATE`, which every ordering role holds — a basket is the first half
 * of placing an order, and gating it behind anything else would let a user
 * assemble a cart they could never submit.
 *
 * **No route takes a cart id.** The basket is always resolved from the
 * authenticated user and the branch they name, so there is no identifier for
 * one colleague to guess another's with.
 */
@ApiTags('cart')
@ApiBearerAuth('access-token')
@RequirePermissions(Permission.ORDER_CREATE)
@Controller('cart')
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  @ApiOperation({
    summary: 'The current basket',
    description:
      'Created on first read. A head-office buyer keeps one basket per branch and selects it ' +
      'with `siteId`; a site user always gets their own branch, whatever they ask for.\n\n' +
      'Carries no prices — a basket is priced by `POST /cart/validate`, because a rate card ' +
      'can change between adding a line and paying for it.',
  })
  async get(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(CartQuerySchema)) query: CartQueryDto,
  ): Promise<CartView> {
    return toCartView(await this.cart.openCart(actor, query.siteId));
  }

  @Post('lines')
  @ApiOperation({
    summary: 'Add a line',
    description:
      'Quantities are stored as typed. Rounding to the MOQ and order multiple is reported by ' +
      'validation, not applied here, so the buyer sees the adjustment rather than finding it ' +
      'on the invoice.\n\n' +
      'Adding the same product and option twice merges the quantities — unless either line ' +
      'carries customisation, because two personalised runs of the same SKU are two different ' +
      'things to print.',
  })
  @ApiZodBody(AddCartLineSchema, {
    example: {
      productId: 'prd_01hzy1',
      quantity: 500,
      customisation: { 'Staff name': 'A. Buyer', Finish: 'Matt' },
    },
  })
  async addLine(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(AddCartLineSchema)) body: AddCartLineDto,
  ): Promise<CartView> {
    return toCartView(await this.cart.addLine(actor, body));
  }

  @Patch('lines/:lineId')
  @ApiOperation({ summary: 'Change a line' })
  @ApiZodBody(UpdateCartLineSchema, { example: { quantity: 1000 } })
  async updateLine(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('lineId') lineId: string,
    @Body(zodBody(UpdateCartLineSchema)) body: UpdateCartLineDto,
  ): Promise<CartView> {
    return toCartView(await this.cart.updateLine(actor, lineId, body));
  }

  @Delete('lines/:lineId')
  @ApiOperation({
    summary: 'Remove a line',
    description: 'Returns the basket rather than 204, so the client re-renders from one response.',
  })
  async removeLine(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('lineId') lineId: string,
  ): Promise<CartView> {
    return toCartView(await this.cart.removeLine(actor, lineId));
  }

  @Delete()
  @ApiOperation({ summary: 'Empty the basket' })
  async clear(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(CartQuerySchema)) query: CartQueryDto,
  ): Promise<CartView> {
    return toCartView(await this.cart.clear(actor, query.siteId));
  }

  @Post('normalise')
  @ApiOperation({
    summary: 'Accept the quantity adjustments',
    description:
      'Rounds every line up to a quantity its product can actually be ordered in. The explicit ' +
      'half of reporting rather than applying: the buyer sees the warnings from `/validate`, ' +
      'then asks for them to be applied.',
  })
  async normalise(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(CartQuerySchema)) query: CartQueryDto,
  ): Promise<CartView> {
    return toCartView(await this.cart.normaliseQuantities(actor, query.siteId));
  }

  @Patch('checkout-details')
  @ApiOperation({
    summary: 'Save a step of the checkout stepper',
    description:
      'Every field is optional so each step saves as the buyer moves through it. ' +
      '`acceptTerms` is a boolean in and a timestamp out — what has to be recorded is when the ' +
      'buyer accepted, and the client must not get to choose that instant.\n\n' +
      'The branch cannot be changed here: a basket belongs to one branch, whose budget, ' +
      "purchase-order rule and addresses all differ. Ask for the other branch's basket instead.",
  })
  @ApiZodBody(SetCheckoutDetailsSchema, {
    example: {
      poNumber: 'ACM-99213',
      campaignCode: 'SPRING-26',
      requestedDeliveryDate: '2026-10-01T00:00:00.000Z',
      shippingAddressId: 'adr_01hzy4',
      paymentMethod: 'NET_30_INVOICE',
      acceptTerms: true,
    },
  })
  async setDetails(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(CartQuerySchema)) query: CartQueryDto,
    @Body(zodBody(SetCheckoutDetailsSchema)) body: SetCheckoutDetailsDto,
  ): Promise<CartView> {
    return toCartView(await this.cart.setDetails(actor, body, query.siteId));
  }

  @Post('validate')
  @ApiOperation({
    summary: 'Price and check the basket',
    description:
      'Reports every problem at once rather than the first, so a buyer with four bad lines ' +
      'sees four messages.\n\n' +
      '`issues` are blocking; `warnings` are adjustments the buyer can accept — a quantity ' +
      'below the MOQ is a warning with the corrected number attached, an unpublished product ' +
      'is a hard stop.\n\n' +
      "Set `forCheckout=true` to also require the stepper's details (branch, delivery " +
      'address, payment method, terms). Off by default so the cart page does not complain ' +
      'about an address the buyer has not reached the step for yet.',
  })
  async validate(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ValidateCartQuerySchema)) query: ValidateCartQueryDto,
  ): Promise<CartValidationView> {
    return toCartValidationView(await this.cart.validate(actor, query.siteId, query.forCheckout));
  }

  @Post('checkout-session')
  @ApiOperation({
    summary: 'The payload an order will be written from',
    description:
      'The same validation as `/validate?forCheckout=true`, but refused with 422 unless the ' +
      'basket is ready. BE-06 takes what this returns and writes the order from it without ' +
      're-deriving anything.\n\n' +
      'Creates nothing, reserves no stock and does not close the basket: all three belong to ' +
      'the order write, and doing any of them here would leave a half-committed state whenever ' +
      'that write failed.',
  })
  async checkoutSession(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(CartQuerySchema)) query: CartQueryDto,
  ): Promise<CartValidationView> {
    return toCartValidationView(await this.cart.checkoutSession(actor, query.siteId));
  }
}

import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Permission, RequirePermissions, type AuthenticatedActor, type OffsetPage } from '@/common';
import { zodBody } from '@/common/pipes/zod-validation.pipe';
import { ApiZodBody } from '@/common/utils/swagger-zod';
import { CurrentUser } from '@/modules/auth';
import { ApprovalsService } from './approvals.service';
import {
  CreateApprovalRuleSchema,
  DecideApprovalSchema,
  ListApprovalsQuerySchema,
  UpdateApprovalRuleSchema,
  type CreateApprovalRuleDto,
  type DecideApprovalDto,
  type ListApprovalsQueryDto,
  type UpdateApprovalRuleDto,
} from './dto/approval.dto';
import {
  toApprovalRequestView,
  toApprovalRuleView,
  type ApprovalRequestView,
  type ApprovalRuleView,
} from './dto/approval-response';

/**
 * The approvals hub (SOW BE-07, FE-06).
 *
 * Deciding needs APPROVAL_ACT. Configuring the rules needs USER_MANAGE, which
 * head office holds within its own tenant — the spending policy is the
 * customer's to write, unlike the catalogue or a rate card.
 */
@ApiTags('approvals')
@ApiBearerAuth('access-token')
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @RequirePermissions(Permission.APPROVAL_ACT)
  @ApiOperation({
    summary: 'The approvals queue',
    description:
      '`mine=true` narrows to what the caller can act on right now: open, at the round the ' +
      'order has actually reached, and addressed to them by name or by role — never their own ' +
      'order. Oldest first, because a queue is worked in the order things arrived.',
  })
  async list(
    @CurrentUser() actor: AuthenticatedActor,
    @Query(zodBody(ListApprovalsQuerySchema)) query: ListApprovalsQueryDto,
  ): Promise<OffsetPage<ApprovalRequestView>> {
    const page = await this.approvals.list(actor, query);
    return { ...page, items: page.items.map(toApprovalRequestView) };
  }

  @Get('orders/:orderId')
  @RequirePermissions(Permission.ORDER_VIEW_OWN)
  @ApiOperation({
    summary: 'The approval an order is going through',
    description:
      'Every step, decided or not, so a buyer can see who their order is with. Gated on ' +
      'ORDER_VIEW_OWN rather than APPROVAL_ACT: watching your own order progress is not an ' +
      'approval right.',
  })
  async findByOrder(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('orderId') orderId: string,
  ): Promise<ApprovalRequestView> {
    return toApprovalRequestView(await this.approvals.findByOrder(actor, orderId));
  }

  @Post('steps/:stepId')
  @RequirePermissions(Permission.APPROVAL_ACT)
  @ApiOperation({
    summary: 'Approve, reject, or request changes',
    description:
      'The decision and the order status it produces commit together — an approved step on an ' +
      'order still sitting in the queue would look to the approver like their click did ' +
      'nothing.\n\n' +
      'A rejection ends the request immediately; waiting for the other approvers would only ' +
      'delay the same answer, and their steps are marked skipped so they leave the queue. A ' +
      'change request pauses it until the buyer resubmits.\n\n' +
      'Refusals must say why, and nobody can decide their own order whatever role they hold.',
  })
  @ApiZodBody(DecideApprovalSchema, {
    example: { decision: 'CHANGES_REQUESTED', comment: 'Split this across two campaigns' },
  })
  async decide(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('stepId') stepId: string,
    @Body(zodBody(DecideApprovalSchema)) body: DecideApprovalDto,
  ): Promise<ApprovalRequestView> {
    return toApprovalRequestView(await this.approvals.decide(actor, stepId, body));
  }

  @Get('rules')
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({
    summary: 'The approval rules in force',
    description:
      '`matchesEverything` flags a rule that states no conditions. That is a legitimate ' +
      'configuration — "all orders need sign-off" — and also the most common way to create one ' +
      'by accident, so it is surfaced rather than left to be worked out.',
  })
  async listRules(
    @CurrentUser() actor: AuthenticatedActor,
    @Query('accountId') accountId?: string,
  ): Promise<ApprovalRuleView[]> {
    const rules = await this.approvals.listRules(actor, accountId);
    return rules.map(toApprovalRuleView);
  }

  @Post('rules')
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({
    summary: 'Add an approval rule',
    description:
      'Conditions are ANDed and an omitted one does not constrain. Exactly one approver — a ' +
      'role or a person — because a rule with none would strand every order it matched.\n\n' +
      'Rules supersede `Account.approvalThreshold`: once an account has any, the threshold is ' +
      'no longer consulted, so the two can never disagree about the same order.',
  })
  @ApiZodBody(CreateApprovalRuleSchema, {
    example: {
      name: 'Over $1,000 to head office',
      minTotal: '1000.00',
      tier: 1,
      approverRole: 'HEAD_OFFICE',
    },
  })
  async createRule(
    @CurrentUser() actor: AuthenticatedActor,
    @Body(zodBody(CreateApprovalRuleSchema)) body: CreateApprovalRuleDto,
  ): Promise<ApprovalRuleView> {
    return toApprovalRuleView(await this.approvals.createRule(actor, body));
  }

  @Patch('rules/:ruleId')
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({
    summary: 'Change an approval rule',
    description:
      'Requests already in flight are unaffected: each step snapshotted the approver its rule ' +
      'named, so editing a rule cannot rewrite who a pending decision was addressed to.',
  })
  @ApiZodBody(UpdateApprovalRuleSchema, { example: { minTotal: '2500.00', active: false } })
  async updateRule(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('ruleId') ruleId: string,
    @Body(zodBody(UpdateApprovalRuleSchema)) body: UpdateApprovalRuleDto,
  ): Promise<ApprovalRuleView> {
    return toApprovalRuleView(await this.approvals.updateRule(actor, ruleId, body));
  }

  @Delete('rules/:ruleId')
  @HttpCode(204)
  @RequirePermissions(Permission.USER_MANAGE)
  @ApiOperation({
    summary: 'Retire an approval rule',
    description:
      'A soft delete. Orders halfway through it keep their steps, because the approver was ' +
      'snapshotted onto each one — retiring a rule never strands an order.',
  })
  async removeRule(
    @CurrentUser() actor: AuthenticatedActor,
    @Param('ruleId') ruleId: string,
  ): Promise<void> {
    await this.approvals.removeRule(actor, ruleId);
  }
}

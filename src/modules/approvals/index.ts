export { ApprovalsModule } from './approvals.module';
export { ApprovalsService } from './approvals.service';
export type { FullApprovalRequest, ApprovalRuleRow } from './approvals.service';
export {
  planApproval,
  ruleMatches,
  canDecideStep,
  evaluateProgress,
  assertStepOpen,
} from './approval-engine';
export type {
  ApprovalRuleSpec,
  OrderFacts,
  PlannedStep,
  RequestProgress,
  StepState,
} from './approval-engine';
export { toApprovalRequestView, toApprovalRuleView } from './dto/approval-response';
export type {
  ApprovalRequestView,
  ApprovalStepView,
  ApprovalRuleView,
} from './dto/approval-response';

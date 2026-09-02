export { MailerModule } from './mailer.module';
export { MailService } from './mail.service';
export type { OutboundMail } from './mail.service';
export { MailDispatcher } from './mail.dispatcher';
export { EmailProcessor } from './email.processor';
export {
  MailJob,
  InvitationJobSchema,
  PasswordResetJobSchema,
  WelcomeJobSchema,
  OrderPlacedJobSchema,
  ApprovalPendingJobSchema,
  ApprovalDecidedJobSchema,
  OrderDispatchedJobSchema,
  LowStockJobSchema,
} from './mail.job';
export type {
  InvitationJobData,
  PasswordResetJobData,
  WelcomeJobData,
  OrderPlacedJobData,
  ApprovalPendingJobData,
  ApprovalDecidedJobData,
  OrderDispatchedJobData,
  LowStockJobData,
} from './mail.job';
export {
  renderInvitationMail,
  renderPasswordResetMail,
  renderWelcomeMail,
  renderOrderPlacedMail,
  renderApprovalPendingMail,
  renderApprovalDecidedMail,
  renderOrderDispatchedMail,
  renderLowStockMail,
} from './mail.templates';
export type { RenderedMail, OrderSummaryInput } from './mail.templates';

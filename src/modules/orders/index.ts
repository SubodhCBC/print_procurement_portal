export { OrdersModule } from './orders.module';
export { OrdersService } from './orders.service';
export type { FullOrder, OrderSummary } from './orders.service';
export {
  OrderStatus,
  allowedTransitions,
  assertTransition,
  canTransition,
  isCommitted,
  isTerminal,
  requiresApproval,
  AWAITING_APPROVAL_STATUSES,
  CANCELLABLE_STATUSES,
  COMMITTED_STATUSES,
  TERMINAL_STATUSES,
} from './order-status';
export { toOrderView } from './dto/order-response';
export type { OrderView, OrderLineView, OrderEventView } from './dto/order-response';

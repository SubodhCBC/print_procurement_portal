/**
 * Transactional email bodies.
 *
 * Plain template functions rather than a templating engine: there are a handful
 * of messages, they are compiled with the application, and a runtime template
 * loader would turn a typo into a production failure instead of a build error.
 * When the set grows past a dozen — or the client wants to edit copy without a
 * deploy — this is the seam to replace, and nothing outside this file changes.
 *
 * Every message ships both an HTML and a plain-text part. Corporate mail
 * gateways routinely strip HTML, and a notification that arrives blank is worse
 * than one that arrives ugly.
 */

export interface RenderedMail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** Escapes interpolated values. Every template puts user data through this. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Shared chrome. Inline styles only — Gmail and Outlook both drop <style>
 * blocks, so a stylesheet would render as unstyled text for most recipients.
 */
function layout(options: { readonly heading: string; readonly body: string }): string {
  return [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;',
    'max-width:560px;margin:0 auto;padding:24px;color:#1a1a1a;line-height:1.5">',
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(options.heading)}</h1>`,
    options.body,
    '<hr style="border:none;border-top:1px solid #e5e5e5;margin:32px 0 16px">',
    '<p style="font-size:12px;color:#767676;margin:0">',
    'This is an automated message from the Ticket-IT portal. Please do not reply to it.',
    '</p></div>',
  ].join('');
}

function button(label: string, url: string): string {
  return [
    `<p style="margin:24px 0"><a href="${escapeHtml(url)}" `,
    'style="background:#1a1a1a;color:#ffffff;text-decoration:none;padding:12px 20px;',
    `border-radius:6px;display:inline-block">${escapeHtml(label)}</a></p>`,
  ].join('');
}

export interface InvitationMailInput {
  readonly firstName: string;
  readonly accountName: string;
  readonly inviterName?: string;
  readonly acceptUrl: string;
  readonly expiresAt: Date;
  readonly isExternal: boolean;
}

export function renderInvitationMail(input: InvitationMailInput): RenderedMail {
  const expires = input.expiresAt.toUTCString();
  const invitedBy = input.inviterName ? ` by ${input.inviterName}` : '';

  const intro = input.isExternal
    ? `You have been given limited access to the ${input.accountName} portal on Ticket-IT.`
    : `You have been invited${invitedBy} to the ${input.accountName} portal on Ticket-IT.`;

  return {
    subject: `Your invitation to the ${input.accountName} portal`,
    html: layout({
      heading: `Hello ${input.firstName},`,
      body: [
        `<p style="margin:0 0 8px">${escapeHtml(intro)}</p>`,
        '<p style="margin:0">Choose a password to activate your account.</p>',
        button('Accept invitation', input.acceptUrl),
        `<p style="font-size:13px;color:#767676;margin:0">This link expires on ${escapeHtml(expires)} `,
        'and can be used once. If you were not expecting it, you can ignore this email — ',
        'no account exists until the invitation is accepted.</p>',
      ].join(''),
    }),
    text: [
      `Hello ${input.firstName},`,
      '',
      intro,
      '',
      'Choose a password to activate your account:',
      input.acceptUrl,
      '',
      `This link expires on ${expires} and can be used once.`,
      'If you were not expecting it you can ignore this email — no account exists',
      'until the invitation is accepted.',
    ].join('\n'),
  };
}

export interface PasswordResetMailInput {
  readonly firstName: string;
  readonly resetUrl: string;
  readonly expiresAt: Date;
}

export function renderPasswordResetMail(input: PasswordResetMailInput): RenderedMail {
  const expires = input.expiresAt.toUTCString();

  return {
    subject: 'Reset your Ticket-IT portal password',
    html: layout({
      heading: `Hello ${input.firstName},`,
      body: [
        '<p style="margin:0">We received a request to reset your portal password.</p>',
        button('Choose a new password', input.resetUrl),
        `<p style="font-size:13px;color:#767676;margin:0">This link expires on ${escapeHtml(expires)} `,
        'and can be used once. If you did not ask for it, no action is needed — ',
        'your current password still works.</p>',
      ].join(''),
    }),
    text: [
      `Hello ${input.firstName},`,
      '',
      'We received a request to reset your portal password:',
      input.resetUrl,
      '',
      `This link expires on ${expires} and can be used once.`,
      'If you did not ask for it, no action is needed — your current password still works.',
    ].join('\n'),
  };
}

export interface WelcomeMailInput {
  readonly firstName: string;
  readonly accountName: string;
  readonly portalUrl: string;
}

export function renderWelcomeMail(input: WelcomeMailInput): RenderedMail {
  return {
    subject: `Your ${input.accountName} portal account is ready`,
    html: layout({
      heading: `Welcome, ${input.firstName}`,
      body: [
        `<p style="margin:0">Your account for the ${escapeHtml(input.accountName)} portal is `,
        'active and you can sign in now.</p>',
        button('Open the portal', input.portalUrl),
      ].join(''),
    }),
    text: [
      `Welcome, ${input.firstName}`,
      '',
      `Your account for the ${input.accountName} portal is active and you can sign in now:`,
      input.portalUrl,
    ].join('\n'),
  };
}

// --- Order notifications (SOW BE-08) ----------------------------------------

/** The order facts every notification repeats back to the reader. */
export interface OrderSummaryInput {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly total: string;
  readonly siteName: string;
  readonly placedByName: string;
  readonly poNumber?: string | null;
  readonly lineCount: number;
}

/**
 * A small facts table, repeated in every order message.
 *
 * A definition list rather than a real table: Outlook renders nested tables
 * inconsistently, and this needs to survive the corporate mail clients the
 * customers actually use rather than looking best in a preview.
 */
function orderFacts(order: OrderSummaryInput): string {
  const rows: Array<[string, string]> = [
    ['Order', order.orderNumber],
    ['Branch', order.siteName],
    ['Raised by', order.placedByName],
    ['Items', String(order.lineCount)],
    ['Total', order.total],
  ];
  if (order.poNumber) rows.push(['Purchase order', order.poNumber]);

  return [
    '<div style="background:#f6f6f6;border-radius:6px;padding:16px;margin:16px 0">',
    ...rows.map(
      ([label, value]) =>
        `<p style="margin:0 0 4px;font-size:14px"><span style="color:#767676">${escapeHtml(label)}: </span>${escapeHtml(value)}</p>`,
    ),
    '</div>',
  ].join('');
}

function orderFactsText(order: OrderSummaryInput): string {
  return [
    `Order:          ${order.orderNumber}`,
    `Branch:         ${order.siteName}`,
    `Raised by:      ${order.placedByName}`,
    `Items:          ${order.lineCount}`,
    `Total:          ${order.total}`,
    ...(order.poNumber ? [`Purchase order: ${order.poNumber}`] : []),
  ].join('\n');
}

export interface OrderPlacedMailInput {
  readonly firstName: string;
  readonly order: OrderSummaryInput;
  readonly awaitingApproval: boolean;
  readonly orderUrl: string;
}

export function renderOrderPlacedMail(input: OrderPlacedMailInput): RenderedMail {
  const next = input.awaitingApproval
    ? 'It is now waiting for approval. You will be emailed as soon as it is decided.'
    : 'It has been approved automatically and is on its way to production.';

  return {
    subject: `Order ${input.order.orderNumber} received`,
    html: layout({
      heading: `Thanks, ${input.firstName}`,
      body: [
        '<p style="margin:0">We have your order.</p>',
        orderFacts(input.order),
        `<p style="margin:0">${escapeHtml(next)}</p>`,
        button('View the order', input.orderUrl),
      ].join(''),
    }),
    text: [
      `Thanks, ${input.firstName}`,
      '',
      'We have your order.',
      '',
      orderFactsText(input.order),
      '',
      next,
      '',
      input.orderUrl,
    ].join('\n'),
  };
}

export interface ApprovalPendingMailInput {
  readonly firstName: string;
  readonly order: OrderSummaryInput;
  readonly tier: number;
  readonly approvalsUrl: string;
}

export function renderApprovalPendingMail(input: ApprovalPendingMailInput): RenderedMail {
  return {
    // The total is in the subject line deliberately: an approver triaging a
    // full inbox decides what to open on value, and making them open each one
    // to find out is how approval queues grow a backlog.
    subject: `Approval needed: ${input.order.orderNumber} (${input.order.total})`,
    html: layout({
      heading: `${input.firstName}, an order needs your decision`,
      body: [
        `<p style="margin:0">${escapeHtml(input.order.placedByName)} has raised an order that `,
        'needs your approval.</p>',
        orderFacts(input.order),
        button('Review it', input.approvalsUrl),
      ].join(''),
    }),
    text: [
      `${input.firstName}, an order needs your decision.`,
      '',
      `${input.order.placedByName} has raised an order that needs your approval.`,
      '',
      orderFactsText(input.order),
      '',
      input.approvalsUrl,
    ].join('\n'),
  };
}

export interface ApprovalDecidedMailInput {
  readonly firstName: string;
  readonly order: OrderSummaryInput;
  readonly decision: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED';
  readonly decidedByName: string;
  readonly comment?: string | null;
  readonly orderUrl: string;
}

export function renderApprovalDecidedMail(input: ApprovalDecidedMailInput): RenderedMail {
  const wording = {
    APPROVED: {
      subject: `Order ${input.order.orderNumber} approved`,
      heading: 'Your order has been approved',
      body: `${input.decidedByName} approved your order. It is on its way to production.`,
    },
    REJECTED: {
      subject: `Order ${input.order.orderNumber} was not approved`,
      heading: 'Your order was not approved',
      body: `${input.decidedByName} did not approve your order.`,
    },
    CHANGES_REQUESTED: {
      subject: `Order ${input.order.orderNumber} needs changes`,
      heading: 'Your order needs changes',
      body: `${input.decidedByName} has asked for changes before this order can go ahead.`,
    },
  }[input.decision];

  // The reason is the whole point of a refusal email — the buyer has to act on
  // it — so it is given its own block rather than being appended to a sentence.
  const reason = input.comment
    ? [
        '<p style="margin:16px 0 4px;font-size:14px;color:#767676">What they said</p>',
        `<p style="margin:0;padding:12px;background:#f6f6f6;border-radius:6px">${escapeHtml(input.comment)}</p>`,
      ].join('')
    : '';

  return {
    subject: wording.subject,
    html: layout({
      heading: `${input.firstName}, ${wording.heading.toLowerCase()}`,
      body: [
        `<p style="margin:0">${escapeHtml(wording.body)}</p>`,
        reason,
        orderFacts(input.order),
        button('View the order', input.orderUrl),
      ].join(''),
    }),
    text: [
      `${input.firstName}, ${wording.heading.toLowerCase()}.`,
      '',
      wording.body,
      ...(input.comment ? ['', 'What they said:', input.comment] : []),
      '',
      orderFactsText(input.order),
      '',
      input.orderUrl,
    ].join('\n'),
  };
}

export interface OrderDispatchedMailInput {
  readonly firstName: string;
  readonly order: OrderSummaryInput;
  readonly carrier?: string | null;
  readonly trackingNumber?: string | null;
  readonly orderUrl: string;
}

export function renderOrderDispatchedMail(input: OrderDispatchedMailInput): RenderedMail {
  const tracking = input.trackingNumber
    ? `${input.carrier ? `${input.carrier}: ` : ''}${input.trackingNumber}`
    : null;

  return {
    subject: `Order ${input.order.orderNumber} is on its way`,
    html: layout({
      heading: `${input.firstName}, your order has been dispatched`,
      body: [
        `<p style="margin:0">Order ${escapeHtml(input.order.orderNumber)} has left us.</p>`,
        // No tracking link: the carrier is configurable and a wrong URL is
        // worse than none. INT-02 adds real links with the 3PL contract.
        tracking
          ? `<p style="margin:16px 0 0"><strong>Tracking:</strong> ${escapeHtml(tracking)}</p>`
          : '',
        orderFacts(input.order),
        button('View the order', input.orderUrl),
      ].join(''),
    }),
    text: [
      `${input.firstName}, your order has been dispatched.`,
      '',
      `Order ${input.order.orderNumber} has left us.`,
      ...(tracking ? ['', `Tracking: ${tracking}`] : []),
      '',
      orderFactsText(input.order),
      '',
      input.orderUrl,
    ].join('\n'),
  };
}

export interface LowStockMailInput {
  readonly firstName: string;
  readonly items: ReadonlyArray<{
    readonly sku: string;
    readonly name: string;
    readonly stockOnHand: number;
    readonly threshold: number;
  }>;
  readonly inventoryUrl: string;
}

export function renderLowStockMail(input: LowStockMailInput): RenderedMail {
  const line = (item: LowStockMailInput['items'][number]) =>
    `${item.sku} — ${item.name}: ${item.stockOnHand} left (threshold ${item.threshold})`;

  return {
    // One digest rather than a message per SKU. A warehouse crossing ten
    // thresholds in a night should get one email, not ten — the second through
    // tenth are what train people to filter the first away.
    subject:
      input.items.length === 1
        ? `Low stock: ${input.items[0]!.sku}`
        : `Low stock: ${input.items.length} items`,
    html: layout({
      heading: `${input.firstName}, stock is running low`,
      body: [
        '<p style="margin:0">These items are at or below their reorder threshold.</p>',
        '<div style="background:#f6f6f6;border-radius:6px;padding:16px;margin:16px 0">',
        ...input.items.map(
          (item) => `<p style="margin:0 0 4px;font-size:14px">${escapeHtml(line(item))}</p>`,
        ),
        '</div>',
        button('Open inventory', input.inventoryUrl),
      ].join(''),
    }),
    text: [
      `${input.firstName}, stock is running low.`,
      '',
      'These items are at or below their reorder threshold:',
      '',
      ...input.items.map(line),
      '',
      input.inventoryUrl,
    ].join('\n'),
  };
}

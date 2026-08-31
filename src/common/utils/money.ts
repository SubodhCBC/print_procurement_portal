/**
 * Money is represented as an integer number of minor units (paise, cents).
 *
 * Rationale: JavaScript numbers are IEEE-754 doubles — `0.1 + 0.2 !== 0.3`.
 * A procurement platform computes rate-card discounts, volume tiers and tax on
 * every line item; float drift there becomes an invoice dispute. Integers are
 * exact, and the database column stays NUMERIC(12,2) so SQL-side aggregation
 * (monthly billing rollups) is exact too.
 *
 * Nothing here knows about pricing rules — those belong in the pricing module.
 */

declare const minorUnitsBrand: unique symbol;

/** Branded integer so a raw `number` cannot be passed where money is expected. */
export type MinorUnits = number & { readonly [minorUnitsBrand]: true };

export const MONEY_SCALE = 2;
const FACTOR = 10 ** MONEY_SCALE;

export function minorUnits(value: number): MinorUnits {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`Money must be a safe integer of minor units, received: ${value}`);
  }
  return value as MinorUnits;
}

/** `"1234.50"` -> 123450. Parsing is exact: the string is never turned into a float. */
export function parseDecimal(value: string): MinorUnits {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) {
    throw new TypeError(`Not a valid ${MONEY_SCALE}-decimal money string: "${value}"`);
  }

  const [, sign, whole, fraction = ''] = match;
  const padded = fraction.padEnd(MONEY_SCALE, '0');
  const magnitude = Number(whole) * FACTOR + Number(padded);

  return minorUnits(sign === '-' ? -magnitude : magnitude);
}

/** 123450 -> `"1234.50"`. Safe for API payloads and NUMERIC columns. */
export function toDecimalString(amount: MinorUnits): string {
  const negative = amount < 0;
  const absolute = Math.abs(amount);
  const whole = Math.trunc(absolute / FACTOR);
  const fraction = String(absolute % FACTOR).padStart(MONEY_SCALE, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export type RoundingMode = 'half-up' | 'half-even' | 'floor' | 'ceil';

function round(value: number, mode: RoundingMode): number {
  switch (mode) {
    case 'floor':
      return Math.floor(value);
    case 'ceil':
      return Math.ceil(value);
    case 'half-even': {
      const floored = Math.floor(value);
      const diff = value - floored;
      if (diff > 0.5) return floored + 1;
      if (diff < 0.5) return floored;
      return floored % 2 === 0 ? floored : floored + 1;
    }
    case 'half-up':
    default:
      return Math.sign(value) * Math.round(Math.abs(value));
  }
}

export function add(...amounts: MinorUnits[]): MinorUnits {
  return minorUnits(amounts.reduce<number>((sum, amount) => sum + amount, 0));
}

export function subtract(a: MinorUnits, b: MinorUnits): MinorUnits {
  return minorUnits(a - b);
}

/** Multiply by a whole quantity — always exact, no rounding involved. */
export function multiplyByQuantity(amount: MinorUnits, quantity: number): MinorUnits {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new TypeError(`Quantity must be a non-negative integer, received: ${quantity}`);
  }
  return minorUnits(amount * quantity);
}

/**
 * Apply a rate (discount, tax, markup). The rounding mode is explicit because
 * finance and the client must agree on it — never let it default silently.
 */
export function applyRate(
  amount: MinorUnits,
  rate: number,
  mode: RoundingMode = 'half-up',
): MinorUnits {
  if (!Number.isFinite(rate)) {
    throw new TypeError(`Rate must be a finite number, received: ${rate}`);
  }
  return minorUnits(round(amount * rate, mode));
}

export const ZERO = minorUnits(0);

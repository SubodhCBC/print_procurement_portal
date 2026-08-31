import { describe, expect, it } from 'vitest';
import {
  add,
  applyRate,
  minorUnits,
  multiplyByQuantity,
  parseDecimal,
  subtract,
  toDecimalString,
} from './money';

describe('money', () => {
  it('parses decimal strings exactly', () => {
    expect(parseDecimal('1234.50')).toBe(123450);
    expect(parseDecimal('0.01')).toBe(1);
    expect(parseDecimal('7')).toBe(700);
    expect(parseDecimal('-12.30')).toBe(-1230);
  });

  it('round-trips through the decimal representation', () => {
    for (const value of ['0.00', '0.05', '19.99', '123456.78', '-4.20']) {
      expect(toDecimalString(parseDecimal(value))).toBe(value);
    }
  });

  it('rejects malformed money strings', () => {
    for (const value of ['1.234', 'abc', '', '1,000.00', '1.']) {
      expect(() => parseDecimal(value)).toThrowError(TypeError);
    }
  });

  it('adds without float drift', () => {
    const total = add(parseDecimal('0.10'), parseDecimal('0.20'));
    expect(toDecimalString(total)).toBe('0.30');
  });

  it('subtracts and multiplies by quantity exactly', () => {
    expect(toDecimalString(subtract(parseDecimal('10.00'), parseDecimal('2.55')))).toBe('7.45');
    expect(toDecimalString(multiplyByQuantity(parseDecimal('19.99'), 250))).toBe('4997.50');
  });

  it('rejects fractional quantities', () => {
    expect(() => multiplyByQuantity(parseDecimal('1.00'), 2.5)).toThrowError(TypeError);
  });

  it('applies a rate with the requested rounding mode', () => {
    const amount = parseDecimal('10.05');
    expect(toDecimalString(applyRate(amount, 0.5, 'half-up'))).toBe('5.03');
    expect(toDecimalString(applyRate(amount, 0.5, 'floor'))).toBe('5.02');
    expect(toDecimalString(applyRate(amount, 0.5, 'ceil'))).toBe('5.03');
  });

  it('refuses unsafe integers', () => {
    expect(() => minorUnits(1.5)).toThrowError(TypeError);
  });
});

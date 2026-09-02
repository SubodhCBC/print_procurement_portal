/**
 * Barrel for the cross-cutting layer. Feature modules import from `@/common`
 * rather than reaching into individual files, so internal reorganisation does
 * not ripple through every domain module.
 */
export * from './constants';
export * from './authorization';
export * from './decorators';
export * from './exceptions';
export * from './interfaces';
export * from './context';
export * from './utils';

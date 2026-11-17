import { describe, expect, it } from 'vitest';
import {
  devServerCsp,
  OVERLAY_PACKAGED_CSP,
  PACKAGED_CSP,
} from '../../src/main/windows/csp';

/** `{ directive: [sources] }` of a policy string. */
function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split('; ').map((part) => {
      const [name, ...sources] = part.split(' ');
      return [name, sources];
    }),
  );
}

describe('PACKAGED_CSP', () => {
  it('is the AD-24 policy, exactly', () => {
    expect(PACKAGED_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it("has script-src 'self' only", () => {
    expect(directives(PACKAGED_CSP)['script-src']).toStrictEqual(["'self'"]);
  });
});

describe('OVERLAY_PACKAGED_CSP', () => {
  it('is the AD-24 policy plus frame-src pack: for the sandboxes (Story 3.5), exactly', () => {
    expect(OVERLAY_PACKAGED_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src pack:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
  });

  it("differs from the panels' policy only by frame-src pack:", () => {
    const { 'frame-src': frameSrc, ...rest } = directives(OVERLAY_PACKAGED_CSP);
    expect(frameSrc).toStrictEqual(['pack:']);
    expect(rest).toStrictEqual(directives(PACKAGED_CSP));
  });
});

describe('devServerCsp', () => {
  const dev = devServerCsp('http://localhost:5173', 'panels');

  it("adds 'unsafe-inline' to script-src and style-src, and the HMR socket to connect-src", () => {
    expect(directives(dev)).toStrictEqual({
      ...directives(PACKAGED_CSP),
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'connect-src': ["'self'", 'ws://localhost:5173'],
    });
  });

  it('keeps the directive order of the packaged policy', () => {
    expect(Object.keys(directives(dev))).toStrictEqual(
      Object.keys(directives(PACKAGED_CSP)),
    );
  });

  it("gives the overlay's dev server its packaged policy's frame-src pack: too", () => {
    const overlay = devServerCsp('http://localhost:5174', 'overlay');
    expect(directives(overlay)).toStrictEqual({
      ...directives(OVERLAY_PACKAGED_CSP),
      'script-src': ["'self'", "'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'connect-src': ["'self'", 'ws://localhost:5174'],
    });
    expect(Object.keys(directives(overlay))).toStrictEqual(
      Object.keys(directives(OVERLAY_PACKAGED_CSP)),
    );
  });

  it('uses wss for an https dev server', () => {
    expect(
      directives(devServerCsp('https://127.0.0.1:5174', 'panels'))[
        'connect-src'
      ],
    ).toStrictEqual(["'self'", 'wss://127.0.0.1:5174']);
  });

  it("never allows 'unsafe-eval' or a wildcard", () => {
    for (const policy of [
      PACKAGED_CSP,
      OVERLAY_PACKAGED_CSP,
      dev,
      devServerCsp('http://localhost:5174', 'overlay'),
    ]) {
      expect(policy).not.toContain('unsafe-eval');
      expect(policy).not.toContain('*');
      expect(policy).not.toContain('http:');
      expect(policy).not.toContain('https:');
    }
  });
});

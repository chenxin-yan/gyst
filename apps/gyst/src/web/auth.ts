import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Fixed at launch: exchanging the bootstrap again, even successfully, never extends it. */
export const bootstrapLifetimeMillis = 10 * 60_000;
export const authCookieName = "gyst_auth";

/**
 * One foreground launch's browser origin and credentials, all fresh and independent per launch.
 * Cookies are not port-scoped, so the random hostname, not the port, keeps another launch's
 * host-only cookie away from this one.
 */
export type Launch = {
  /** `g-<128-bit hex>.localhost`; browsers resolve `.localhost` to loopback themselves. */
  readonly hostname: string;
  /** 256-bit secret carried only in the launch URL fragment and the bootstrap `Authorization`. */
  readonly bootstrap: string;
  /** 256-bit auth cookie value, valid until this launch's server stops. */
  readonly cookie: string;
  readonly bootstrapExpiresAt: number;
};

export const makeLaunch = (now: number): Launch => ({
  hostname: `g-${randomBytes(16).toString("hex")}.localhost`,
  bootstrap: randomBytes(32).toString("base64url"),
  cookie: randomBytes(32).toString("base64url"),
  bootstrapExpiresAt: now + bootstrapLifetimeMillis,
});

const digest = (value: string) => createHash("sha256").update(value).digest();
/** Compares equal-length digests in constant time, so timing does not reveal the secret. */
const sameSecret = (given: string, secret: string) =>
  timingSafeEqual(digest(given), digest(secret));

/**
 * `Host` must name exactly this launch's hostname with an explicit valid port. The port is the
 * browser-visible one, which differs from the listener's behind an SSH forward.
 */
export const isLaunchHost = (launch: Launch, host: string | undefined): host is string => {
  if (host === undefined || !host.startsWith(`${launch.hostname}:`)) return false;
  const port = host.slice(launch.hostname.length + 1);
  return /^[1-9]\d{0,4}$/.test(port) && Number(port) <= 65_535;
};

/** A browser POST's serialized `Origin` must be exactly this request's already-validated `Host`. */
export const isSameOrigin = (host: string, origin: string | undefined) =>
  origin === `http://${host}`;

export const isBootstrap = (launch: Launch, authorization: string | undefined, now: number) => {
  const token = authorization?.match(/^Bearer ([\w-]+)$/)?.[1];
  return (
    token !== undefined && now < launch.bootstrapExpiresAt && sameSecret(token, launch.bootstrap)
  );
};

/** Any `gyst_auth` pair may match, so a planted same-name cookie cannot shadow the real one. */
export const hasAuthCookie = (launch: Launch, cookieHeader: string | undefined) =>
  (cookieHeader ?? "").split(";").some((pair) => {
    const [name, value] = pair.trim().split("=", 2);
    return name === authCookieName && value !== undefined && sameSecret(value, launch.cookie);
  });

/** Host-only (no `Domain`), so it never leaves this launch's hostname; session lifetime. */
export const authCookie = (launch: Launch) =>
  `${authCookieName}=${launch.cookie}; Path=/; HttpOnly; SameSite=Strict`;

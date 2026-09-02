/**
 * Checks one real credential against the legacy database, without starting the
 * API or writing anything anywhere.
 *
 *   npx tsx scripts/verify-legacy-login.ts <login> <password>
 *
 * Why this exists: the SimpleMembership hash format was confirmed structurally
 * against live data (every sampled row decodes to 49 bytes behind a 0x00
 * marker), but confirming the *derivation* — PBKDF2-HMAC-SHA1 at 1000
 * iterations over the UTF-8 password — needs one known-good password, and the
 * legacy database stores none in plaintext (`Users.InitialPassword` holds a
 * 16-byte encrypted blob, not the password). Run this once with a QA account
 * and the whole first-login path is proven end to end.
 *
 * Prints only which scheme matched. Never the password, never a hash.
 */
import { createLegacyPrismaClient } from '../src/database/legacy';
import { verifyLegacyPassword } from '../src/modules/auth/password/legacy-password.verifier';

const [loginArg, passwordArg] = process.argv.slice(2);

if (!loginArg || !passwordArg) {
  console.error('Usage: npx tsx scripts/verify-legacy-login.ts <login> <password>');
  process.exit(2);
}

const login: string = loginArg;
const password: string = passwordArg;

const prisma = createLegacyPrismaClient();

async function main(): Promise<void> {
  const user = await prisma.users.findFirst({
    where: { Login: login },
    include: { webpages_UsersInRoles: { include: { webpages_Roles: true } } },
  });

  if (!user) {
    console.error(`✖ No legacy user with login "${login}".`);
    process.exitCode = 1;
    return;
  }

  const membership = await prisma.webpages_Membership.findUnique({
    where: { UserId: user.Id },
    select: { Password: true },
  });

  console.log('Legacy user found:');
  console.table({
    legacyUserId: user.Id,
    login: user.Login,
    client: user.Client,
    role: user.webpages_UsersInRoles[0]?.webpages_Roles.RoleName ?? '(none)',
    isActive: user.IsActive,
    hasBcryptHash: Boolean(user.UserPassword),
    hasMembershipHash: Boolean(membership?.Password),
  });

  const result = await verifyLegacyPassword(password, {
    bcryptHash: user.UserPassword,
    membershipHash: membership?.Password ?? null,
  });

  if (result.valid) {
    console.log(`✅ Password verified via ${result.scheme}.`);
    console.log('   The first-login path will authenticate and replicate this user.');
  } else {
    console.error('✖ Password did not match either legacy hash.');
    console.error('   Either the password is wrong, or the hash derivation needs revisiting.');
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    console.error('Failed to reach the legacy database:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
